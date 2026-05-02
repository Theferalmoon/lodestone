// SPDX-License-Identifier: Apache-2.0
// Insert helpers for symbols, edges, class_inheritance, embeddings. Maps the
// in-memory LodestoneGraph (graphology MultiDirectedGraph) and the parser
// outputs (LodestoneSymbol, ClassInheritance) to the canonical SQLite rows
// defined in @lodestone/shared/schema.

import type Database from "better-sqlite3";

import type {
  ClassInheritance,
  ClassInheritanceRow,
  EdgeKind,
  EdgeRow,
  FeedbackEvent,
  FeedbackRow,
  LodestoneSymbol,
  SymbolRow,
} from "@lodestone/shared";

import type { LodestoneGraph } from "../graph/builder.js";
import { getEmbedderIdentity } from "./index-meta.js";
import { VECTOR_DIM } from "./sqlite.js";

/** Embedding row passed into writeEmbeddings - one per symbol id. */
export interface EmbeddingRow {
  symbol_id: string;
  /** float32 array whose length must match the active embedder dim
   * (see index_meta.embedder_dim); falls back to VECTOR_DIM when no
   * embedder identity has been recorded yet. */
  vector: Float32Array;
}

/** Optional metadata applied to every SymbolRow during a write pass. */
export interface SymbolWriteContext {
  index_epoch: number;
  /** Last commit that touched the working tree, or null when not a git repo. */
  commit?: string | null;
}

/**
 * vec0 virtual-table DDL. Vector dim must be baked into the CREATE — vec0
 * does not support a runtime-variable dim. We consult the recorded
 * `index_meta.embedder_dim` first and fall back to the legacy `VECTOR_DIM`
 * constant only when no embedder identity has been recorded yet (fresh
 * bootstrap, tests that hand-roll a DB).
 *
 * Switching embedder dim on an existing index is NOT supported in-place —
 * `beginReindex` clears the rows but the schema sticks. To switch dim, the
 * operator runs `lodestone reindex --reset` which physically removes the
 * sqlite file. Silently tolerating a dim swap would leave dead vectors keyed
 * by the old dim that vec0 cannot evict.
 */
function createVecTableSql(dim: number): string {
  return `CREATE VIRTUAL TABLE IF NOT EXISTS symbol_embeddings USING vec0(
  symbol_id TEXT PRIMARY KEY,
  embedding FLOAT[${dim}]
)`;
}

/**
 * Insert or update symbols. Every row inherits index_epoch and (optionally)
 * updated_at_commit from ctx. Existing rows on conflict get the new
 * pagerank/cluster_id/signature/etc - the symbol id is the immutable key.
 */
export function writeSymbols(
  db: Database.Database,
  symbols: readonly LodestoneSymbol[],
  ctx: SymbolWriteContext,
): number {
  const stmt = db.prepare(
    `INSERT INTO symbols (
       id, path, language, kind,
       range_start_line, range_end_line,
       signature, docstring, pagerank, cluster_id,
       updated_at_commit, updated_at_epoch
     ) VALUES (
       @id, @path, @language, @kind,
       @range_start_line, @range_end_line,
       @signature, @docstring, @pagerank, @cluster_id,
       @updated_at_commit, @updated_at_epoch
     )
     ON CONFLICT(id) DO UPDATE SET
       path = excluded.path,
       language = excluded.language,
       kind = excluded.kind,
       range_start_line = excluded.range_start_line,
       range_end_line = excluded.range_end_line,
       signature = COALESCE(excluded.signature, symbols.signature),
       docstring = COALESCE(excluded.docstring, symbols.docstring),
       updated_at_commit = COALESCE(excluded.updated_at_commit, symbols.updated_at_commit),
       updated_at_epoch = excluded.updated_at_epoch`,
  );

  const insertMany = db.transaction((rows: SymbolRow[]) => {
    for (const r of rows) stmt.run(r);
  });

  const rows: SymbolRow[] = symbols.map((s) => symbolToRow(s, ctx));
  insertMany(rows);
  return rows.length;
}

/**
 * Insert or replace edges. Edges with (from_id, to_id, kind) collisions
 * accumulate weight (matches the in-memory graph aggregation semantics).
 *
 * Source data is the LodestoneGraph from section 7 buildGraph(); each
 * edge carries kind + weight, and from/to are canonical symbol ids.
 *
 * External (stub) nodes are skipped - they have no SymbolRow to reference,
 * and the edges table FK would reject them. The graph keeps stubs so PageRank
 * sees full adjacency, but the persistent layer drops them.
 */
export function writeEdges(db: Database.Database, graph: LodestoneGraph): number {
  const stmt = db.prepare(
    `INSERT INTO edges (from_id, to_id, kind, weight)
     VALUES (@from_id, @to_id, @kind, @weight)
     ON CONFLICT(from_id, to_id, kind) DO UPDATE SET
       weight = edges.weight + excluded.weight`,
  );

  const rows: EdgeRow[] = [];
  graph.forEachDirectedEdge((_key, attrs, source, target) => {
    const sourceAttrs = graph.getNodeAttributes(source);
    const targetAttrs = graph.getNodeAttributes(target);
    if (sourceAttrs.external || targetAttrs.external) return;
    rows.push({
      from_id: source,
      to_id: target,
      kind: attrs.kind,
      weight: attrs.weight,
    });
  });

  const insertMany = db.transaction((batch: EdgeRow[]) => {
    for (const r of batch) stmt.run(r);
  });
  insertMany(rows);
  return rows.length;
}

/**
 * Update the pagerank column on each symbol. Accepts the Map returned by
 * section 7's pageRank() helper; external (stub) nodes are skipped because
 * they have no SymbolRow to update. Done as a separate pass because pageRank
 * runs after writeSymbols and the values shouldn't be in symbolToRow (parser
 * output has no pagerank).
 *
 * The optional `graph` argument is used only to detect external stub nodes;
 * when omitted, every key in the map is written.
 */
export function writePagerank(
  db: Database.Database,
  pageRankOrGraph: Map<string, number> | LodestoneGraph,
  graph?: LodestoneGraph,
): number {
  // Support two call shapes for ergonomics:
  //   writePagerank(db, pageRankMap) - simple
  //   writePagerank(db, pageRankMap, graph) - skips external nodes
  //   writePagerank(db, graph) - reads attrs.pagerank set by an earlier
  //     in-place pagerank.assign() call
  let entries: Iterable<[string, number]>;
  let stubProbe: LodestoneGraph | undefined;
  if (pageRankOrGraph instanceof Map) {
    entries = pageRankOrGraph.entries();
    stubProbe = graph;
  } else {
    const g = pageRankOrGraph;
    stubProbe = g;
    const collected: Array<[string, number]> = [];
    g.forEachNode((id, attrs) => {
      const pr = (attrs as unknown as { pagerank?: number }).pagerank;
      if (typeof pr === "number") collected.push([id, pr]);
    });
    entries = collected;
  }

  const stmt = db.prepare("UPDATE symbols SET pagerank = ? WHERE id = ?");
  let updated = 0;
  const tx = db.transaction(() => {
    for (const [id, score] of entries) {
      if (stubProbe?.hasNode(id) && stubProbe.getNodeAttributes(id).external) {
        continue;
      }
      const result = stmt.run(score, id);
      if (result.changes > 0) updated++;
    }
  });
  tx();
  return updated;
}

/**
 * Insert class-inheritance triples. Conflicts on (class_id, base_name)
 * refresh the `base_path`. Migration 003 (Codex impl-008 §08 YELLOW) widened
 * the PK from `class_id` alone to the composite, so multi-inheritance
 * languages (TypeScript `extends X implements Y, Z`, Python `class C(A,
 * B):`) now retain every base instead of collapsing to whichever triple was
 * written last.
 */
export function writeClassInheritance(
  db: Database.Database,
  triples: readonly ClassInheritance[],
): number {
  const stmt = db.prepare(
    `INSERT INTO class_inheritance (class_id, base_name, base_path)
     VALUES (@class_id, @base_name, @base_path)
     ON CONFLICT(class_id, base_name) DO UPDATE SET
       base_path = excluded.base_path`,
  );
  const rows: ClassInheritanceRow[] = triples.map((t) => ({
    class_id: t.class_id,
    base_name: t.base_name,
    base_path: t.base_path ?? null,
  }));
  const tx = db.transaction(() => {
    for (const r of rows) stmt.run(r);
  });
  tx();
  return rows.length;
}

/**
 * Resolve the active vector dim — `index_meta.embedder_dim` if a pipeline
 * pass has stamped one, else the legacy `VECTOR_DIM` constant.
 */
function resolveVectorDim(db: Database.Database): number {
  const embedder = getEmbedderIdentity(db);
  return embedder?.dim ?? VECTOR_DIM;
}

/**
 * Ensure the sqlite-vec virtual table exists. Idempotent — a missing vec0
 * table is created with the recorded embedder dim (falls back to
 * `VECTOR_DIM`). Callers that want a fresh index can DROP first or use
 * `beginReindex`, which clears every per-pass row including the vec0 table.
 *
 * The symbol-body vector table lives outside the canonical migrations file
 * because vec0 is a virtual-table extension; baking it into 001-initial.sql
 * would require sqlite-vec to be loaded at every bootstrap (which it is, but
 * keeping the DDL programmatic makes the dependency explicit at the call
 * site AND lets us splice the active embedder dim into the CREATE).
 */
export function ensureSymbolEmbeddingsTable(db: Database.Database): void {
  const dim = resolveVectorDim(db);
  // db.exec is the better-sqlite3 multi-statement runner — NOT child process.
  db.exec(createVecTableSql(dim));
}

/**
 * Replace embeddings for the given symbol ids. Each row vector must match
 * the active embedder dim — read from `index_meta.embedder_dim` when set,
 * else the legacy `VECTOR_DIM` (768). A mismatch throws a descriptive error
 * naming the offending symbol AND both dims so the caller knows whether the
 * ingest pipeline forgot to stamp identity (impl-008 RED #3 fixup).
 */
export function writeEmbeddings(
  db: Database.Database,
  rows: readonly EmbeddingRow[],
): number {
  ensureSymbolEmbeddingsTable(db);
  const expectedDim = resolveVectorDim(db);
  const insertStmt = db.prepare(
    `INSERT OR REPLACE INTO symbol_embeddings (symbol_id, embedding) VALUES (?, ?)`,
  );
  const tx = db.transaction(() => {
    for (const r of rows) {
      if (r.vector.length !== expectedDim) {
        throw new Error(
          `Embedding for ${r.symbol_id} has length ${r.vector.length}, expected ${expectedDim}.`,
        );
      }
      // sqlite-vec accepts a Buffer view of a Float32Array as a vector blob.
      insertStmt.run(
        r.symbol_id,
        Buffer.from(r.vector.buffer, r.vector.byteOffset, r.vector.byteLength),
      );
    }
  });
  tx();
  return rows.length;
}

function symbolToRow(s: LodestoneSymbol, ctx: SymbolWriteContext): SymbolRow {
  return {
    id: s.symbol,
    path: s.path,
    language: s.language,
    kind: s.kind,
    range_start_line: s.range.start_line,
    range_end_line: s.range.end_line,
    signature: s.signature ?? null,
    docstring: s.docstring ?? null,
    pagerank: null,
    cluster_id: s.cluster_id ?? null,
    updated_at_commit: ctx.commit ?? null,
    updated_at_epoch: ctx.index_epoch,
  };
}

/** Type guard helper - useful in tests to discriminate edge kinds. */
export function isEdgeKind(value: string): value is EdgeKind {
  return value === "calls" || value === "imports" || value === "extends" || value === "implements";
}

/**
 * Insert a single agent-feedback event into the `feedback` table. The MCP
 * `feedback` tool (§17) is the only write surface in v0; every other MCP tool
 * uses a read-only handle. Returns the AUTOINCREMENT id assigned by SQLite —
 * useful for callers that want to log/correlate the persisted row.
 *
 * The `recorded_at` field on FeedbackEvent is server-stamped (the agent never
 * supplies it). Validation of `signal` against the FeedbackSignal union and
 * truncation of oversized `note` happen in the MCP handler before reaching
 * this helper — the writer trusts its inputs because the trust boundary lives
 * in the handler. Keeping the writer dumb means other future write paths
 * (e.g. CLI `lodestone feedback record`) can reuse it without re-validating.
 */
export function writeFeedback(db: Database.Database, event: FeedbackEvent): number {
  const stmt = db.prepare(
    `INSERT INTO feedback (recorded_at, tool, request_id, signal, note)
     VALUES (@recorded_at, @tool, @request_id, @signal, @note)`,
  );
  const row: Omit<FeedbackRow, "id"> = {
    recorded_at: event.recorded_at,
    tool: event.tool,
    request_id: event.request_id,
    signal: event.signal,
    note: event.note ?? null,
  };
  const result = stmt.run(row);
  return Number(result.lastInsertRowid);
}

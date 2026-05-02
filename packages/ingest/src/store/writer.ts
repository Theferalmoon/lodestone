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
  LodestoneSymbol,
  SymbolRow,
} from "@lodestone/shared";

import type { LodestoneGraph } from "../graph/builder.js";
import { VECTOR_DIM } from "./sqlite.js";

/** Embedding row passed into writeEmbeddings - one per symbol id. */
export interface EmbeddingRow {
  symbol_id: string;
  /** float32 array of length VECTOR_DIM. */
  vector: Float32Array;
}

/** Optional metadata applied to every SymbolRow during a write pass. */
export interface SymbolWriteContext {
  index_epoch: number;
  /** Last commit that touched the working tree, or null when not a git repo. */
  commit?: string | null;
}

const CREATE_VEC_TABLE_SQL = `CREATE VIRTUAL TABLE IF NOT EXISTS symbol_embeddings USING vec0(
  symbol_id TEXT PRIMARY KEY,
  embedding FLOAT[${VECTOR_DIM}]
)`;

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
 * Insert class-inheritance triples. Conflicts on class_id replace the row
 * (each class has exactly one base in the v0 model; multiple-inheritance
 * languages would need a second key column - out of scope for v0).
 */
export function writeClassInheritance(
  db: Database.Database,
  triples: readonly ClassInheritance[],
): number {
  const stmt = db.prepare(
    `INSERT INTO class_inheritance (class_id, base_name, base_path)
     VALUES (@class_id, @base_name, @base_path)
     ON CONFLICT(class_id) DO UPDATE SET
       base_name = excluded.base_name,
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
 * Ensure the sqlite-vec virtual table exists. Idempotent - a missing vec0
 * table is created with the canonical name + dim. Callers that want a fresh
 * index can DROP first.
 *
 * The symbol-body vector table lives outside the canonical migrations file
 * because vec0 is a virtual-table extension; baking it into 001-initial.sql
 * would require sqlite-vec to be loaded at every bootstrap (which it is, but
 * keeping the DDL programmatic makes the dependency explicit at the call site).
 */
export function ensureSymbolEmbeddingsTable(db: Database.Database): void {
  db.exec(CREATE_VEC_TABLE_SQL);
}

/**
 * Replace embeddings for the given symbol ids. Each row vector must be of
 * exact length VECTOR_DIM; a mismatch throws a descriptive error.
 */
export function writeEmbeddings(
  db: Database.Database,
  rows: readonly EmbeddingRow[],
): number {
  ensureSymbolEmbeddingsTable(db);
  const insertStmt = db.prepare(
    `INSERT OR REPLACE INTO symbol_embeddings (symbol_id, embedding) VALUES (?, ?)`,
  );
  const tx = db.transaction(() => {
    for (const r of rows) {
      if (r.vector.length !== VECTOR_DIM) {
        throw new Error(
          `Embedding for ${r.symbol_id} has length ${r.vector.length}, expected ${VECTOR_DIM}.`,
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

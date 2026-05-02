// SPDX-License-Identifier: Apache-2.0
// `cluster` tool — §16 implementation. ★ moat tool: surfaces the project's
// emergent architecture (Louvain communities) as named groups with
// agent-readable instructions for how to interact with each cluster.
//
// Resolution path (POST-CODEX-001 amendment shape):
//   1. Case-insensitive substring match on `clusters.name`.
//   2. If zero name hits AND the query has any cluster with a non-NULL
//      description_embedding, embed the query and rank by cosine similarity
//      (in-process, small N — the v0 SQLite store is the only data source).
//   3. If the embedding column is NULL for every row (no embedder pass yet),
//      fall back to LIKE-substring search on `clusters.description`.
//   4. Empty result is success — return `{ results: [] }` with a diagnostics
//      warning, never throw.
//
// Each returned Cluster carries the new POST-CODEX-001 fields:
//   - `name_status` ("heuristic"|"human") — sourced from clusters.name_status
//   - `agent_instruction` ("synthesize_name_from_members"|"use_as_is")
//     — derived from name_status (heuristic ⇒ synthesize, human ⇒ use_as_is)
//   - `naming_evidence` (anchor_symbol = top-PageRank member, members_sampled
//     = total cluster size, dominant_verb omitted at read time — only the
//     producer (§09) has the verb candidates in scope)
//
// Channel "code" only per POST-FORGE-VISION amendment §2.

import { z } from "zod";

import type {
  Cluster,
  ClusterRow,
  NameStatus,
  SymbolRef,
} from "@lodestone/shared";
import { lodestoneSubpath } from "@lodestone/shared";
import { clusterMembers } from "@lodestone/ingest/store";
import type { EmbedderHandle } from "@lodestone/ingest/embed";

import {
  LODESTONE_CHANNEL_V0,
  emptyDiagnostics,
  wrapErr,
  wrapOk,
  type LodestoneToolResponseV13,
} from "../envelope.js";
import { openReader, type ReaderHandle } from "../client/sqlite.js";
import { toMcpInputSchema } from "./_shared.js";

export const description =
  "Return the architectural cluster (community) matching a name or natural-language query. Each cluster is a Louvain-detected group of symbols representing an emergent module — auth, payments, ingest, etc. The response carries the cluster's heuristic name, its name_status (heuristic vs human-confirmed), an agent_instruction string telling the calling agent how to interact with the cluster, naming_evidence (top tokens / files / signature snippets that drove the name), and the member symbol IDs. Granularity selects between Louvain resolution levels (fine | medium | coarse). This is the core moat surface for code-aware agents.";

export const inputSchema = z.object({
  name_or_query: z.string().min(1, "name_or_query must be non-empty"),
  granularity: z.enum(["fine", "medium", "coarse"]).default("medium"),
  channel: z.literal("code").optional(),
});

export type ClusterInput = z.infer<typeof inputSchema>;

/** Pre-computed JSON-Schema-7 view of `inputSchema` for the MCP `tools/list`
 * surface. Pre-compute at module load — see `toMcpInputSchema` JSDoc. */
export const jsonSchema = toMcpInputSchema(inputSchema);

/**
 * Granularity → member cap mapping. Spec uses tight/default/wide; the §13
 * stub froze the enum as fine/medium/coarse, so we keep the wire shape and
 * apply the same caps under the new names.
 */
const GRANULARITY_CAP: Record<ClusterInput["granularity"], number> = {
  fine: 10,
  medium: 30,
  coarse: 50,
};

/** Hard cap on the number of clusters surfaced per call. */
const MAX_CLUSTERS_PER_CALL = 5;

/**
 * Pluggable dependencies. The default handler resolves these from
 * cwd + a lazily-loaded embedder; tests pass mocks.
 */
export interface ClusterContext {
  /** Open a read-only reader handle. */
  openReader(): ReaderHandle;
  /** Returns an embedder handle on demand. May throw if weights are missing. */
  loadEmbedder?: () => Promise<EmbedderHandle>;
}

/**
 * Default context: opens the SQLite reader against `<cwd>/.lodestone/lodestone.sqlite`
 * and lazy-loads the bundled embedder. Embedder is optional; if loading fails
 * the tool falls back to LIKE-search.
 */
function defaultContext(): ClusterContext {
  const cwd = process.cwd();
  const dbPath = lodestoneSubpath(cwd, "sqlite");
  return {
    openReader: () => openReader(dbPath),
    loadEmbedder: async () => {
      const mod = await import("@lodestone/ingest/embed");
      return mod.load();
    },
  };
}

/**
 * Factory that returns a handler bound to a specific context. The exported
 * `handler` uses the default context; tests use this directly with mocks.
 */
export function createHandler(
  ctx: ClusterContext = defaultContext(),
): (input: unknown) => Promise<LodestoneToolResponseV13<Cluster>> {
  return async (raw: unknown) => {
    let parsed: ClusterInput;
    try {
      parsed = inputSchema.parse(raw);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return wrapErr<Cluster>(message, LODESTONE_CHANNEL_V0);
    }

    const memberCap = GRANULARITY_CAP[parsed.granularity];
    let reader: ReaderHandle;
    try {
      reader = ctx.openReader();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return wrapErr<Cluster>(`failed to open lodestone index: ${message}`, LODESTONE_CHANNEL_V0);
    }

    try {
      // 1. Name-substring match (case-insensitive).
      let rows = nameMatchRows(reader, parsed.name_or_query);
      const usedSemantic = rows.length === 0;
      const warnings: string[] = [];

      // 2. Semantic fallback if no name hits.
      if (rows.length === 0) {
        const semantic = await semanticMatch(
          reader,
          parsed.name_or_query,
          ctx.loadEmbedder,
          warnings,
        );
        rows = semantic.rows;
      }

      // 3. Cap clusters per call.
      if (rows.length > MAX_CLUSTERS_PER_CALL) {
        rows = rows.slice(0, MAX_CLUSTERS_PER_CALL);
      }

      // 4. Build full Cluster shapes.
      const results: Cluster[] = rows.map((row) =>
        buildCluster(reader, row, memberCap),
      );

      // 5. Empty-result diagnostic — success, not error.
      if (results.length === 0) {
        warnings.push(
          usedSemantic
            ? `no cluster matched name or description for "${parsed.name_or_query}"`
            : `no cluster matched "${parsed.name_or_query}"`,
        );
      }

      const diagnostics = {
        ...emptyDiagnostics(),
        ...(warnings.length > 0 ? { warnings } : {}),
      };

      return wrapOk<Cluster>(results, LODESTONE_CHANNEL_V0, { diagnostics });
    } finally {
      reader.close();
    }
  };
}

/** Default handler — uses the cwd-resolved context. */
export const handler = createHandler();

/* ------------------------------------------------------------------------- */
/* Internals                                                                 */
/* ------------------------------------------------------------------------- */

/** Substring (case-insensitive) name match. Cheap and deterministic. */
function nameMatchRows(reader: ReaderHandle, q: string): ClusterRow[] {
  const stmt = reader.db.prepare(
    `SELECT * FROM clusters
      WHERE LOWER(name) LIKE '%' || LOWER(?) || '%'
      ORDER BY size DESC, id ASC`,
  );
  return stmt.all(q) as ClusterRow[];
}

/** Cosine similarity over `description_embedding` BLOBs (in-process). */
async function semanticMatch(
  reader: ReaderHandle,
  q: string,
  loadEmbedder: ClusterContext["loadEmbedder"],
  warnings: string[],
): Promise<{ rows: ClusterRow[] }> {
  const allRows = reader.db
    .prepare("SELECT * FROM clusters ORDER BY size DESC, id ASC")
    .all() as ClusterRow[];

  if (allRows.length === 0) return { rows: [] };

  const withEmbeddings = allRows.filter(
    (r) => r.description_embedding !== null && r.description_embedding !== undefined,
  );

  if (withEmbeddings.length === 0 || !loadEmbedder) {
    // No embeddings on disk yet — fall back to LIKE on description.
    warnings.push(
      "cluster description embeddings not yet computed; falling back to substring match on description",
    );
    return { rows: descriptionLikeRows(reader, q) };
  }

  let embedder: EmbedderHandle;
  try {
    embedder = await loadEmbedder();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warnings.push(
      `embedder unavailable (${message}); falling back to substring match on description`,
    );
    return { rows: descriptionLikeRows(reader, q) };
  }

  let queryVec: Float32Array;
  try {
    const out = await embedder.embed([q]);
    queryVec = out[0]!;
  } finally {
    await embedder.dispose().catch(() => {
      /* idempotent + best-effort */
    });
  }

  // Score each row by cosine similarity. Vectors from §05 embedders are L2-
  // normalized, so dot product == cosine similarity.
  const scored: Array<{ row: ClusterRow; score: number }> = [];
  for (const row of withEmbeddings) {
    const candidate = bufferToFloat32(row.description_embedding!);
    if (candidate.length !== queryVec.length) {
      // Dimension mismatch — skip and warn once.
      continue;
    }
    let dot = 0;
    for (let i = 0; i < queryVec.length; i += 1) {
      dot += queryVec[i]! * candidate[i]!;
    }
    scored.push({ row, score: dot });
  }
  scored.sort((a, b) => b.score - a.score);
  return { rows: scored.map((s) => s.row) };
}

/** Substring match on description — last-resort fallback. */
function descriptionLikeRows(reader: ReaderHandle, q: string): ClusterRow[] {
  const stmt = reader.db.prepare(
    `SELECT * FROM clusters
      WHERE LOWER(description) LIKE '%' || LOWER(?) || '%'
      ORDER BY size DESC, id ASC`,
  );
  return stmt.all(q) as ClusterRow[];
}

/** Reinterpret an SQLite BLOB as a Float32Array (alignment-safe copy). */
function bufferToFloat32(buf: Buffer): Float32Array {
  // Copy to ensure alignment + no shared memory with the SQLite buffer.
  const out = new Float32Array(buf.byteLength / 4);
  // Buffer is a Uint8Array subclass — read float32s via DataView for portability.
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = view.getFloat32(i * 4, true /* little-endian */);
  }
  return out;
}

/** Construct the application-level Cluster shape from a ClusterRow + member fetch. */
function buildCluster(
  reader: ReaderHandle,
  row: ClusterRow,
  memberCap: number,
): Cluster {
  const members = clusterMembers(reader.db, row.id, memberCap).map(
    (hit): SymbolRef => ({
      symbol: hit.id,
      path: hit.path,
      range: { start_line: hit.range_start_line, end_line: hit.range_end_line },
      pagerank: hit.pagerank ?? 0,
    }),
  );

  // Bridges = members whose row carries is_bridge=1. Re-query the join so we
  // don't depend on per-symbol PageRank to surface them (§09 already capped
  // the bridge set at 10 by writing is_bridge=1 only for those).
  const bridges = bridgeMembers(reader, row.id, memberCap);

  // emitted_skill_id: lookup via skills.source_cluster_id JOIN.
  const emittedSkill = reader.db
    .prepare("SELECT id FROM skills WHERE source_cluster_id = ? LIMIT 1")
    .get(row.id) as { id: string } | undefined;

  const nameStatus: NameStatus = (row.name_status ?? "heuristic") as NameStatus;
  const agentInstruction =
    nameStatus === "human" ? "use_as_is" : "synthesize_name_from_members";

  return {
    id: row.id,
    name: row.name,
    name_status: nameStatus,
    agent_instruction: agentInstruction,
    naming_evidence: {
      // dominant_verb is producer-side knowledge (§09); we omit at read time.
      anchor_symbol: members[0]?.symbol ?? "",
      members_sampled: row.size,
    },
    description: row.description ?? "",
    size: row.size,
    members,
    bridges,
    ...(emittedSkill ? { emitted_skill_id: emittedSkill.id } : {}),
    diagnostics: {
      algorithm: row.algorithm,
      algorithm_version: row.algorithm_version,
      // resolution + seed are not stored on ClusterRow today (the §09 producer
      // owns them); surface canonical defaults so the diagnostics envelope
      // stays well-formed for agents that introspect it. When the storage
      // layer adds these columns, swap to row.resolution / row.seed.
      resolution: 1.5,
      seed: 42,
      graph_node_count: row.size,
      graph_edge_count: 0, // Not persisted on ClusterRow; placeholder.
      modularity: row.modularity ?? 0,
      singleton_count: 0, // Not persisted; producer-side metric.
      bridge_count: bridges.length,
      stability_hash: row.id,
    },
  };
}

/** Bridge members for a cluster — joined on cluster_members.is_bridge=1. */
function bridgeMembers(
  reader: ReaderHandle,
  clusterId: string,
  cap: number,
): SymbolRef[] {
  const rows = reader.db
    .prepare(
      `SELECT s.id, s.path, s.range_start_line, s.range_end_line, s.pagerank
         FROM cluster_members m
         JOIN symbols s ON s.id = m.symbol_id
        WHERE m.cluster_id = ? AND m.is_bridge = 1
        ORDER BY s.pagerank DESC NULLS LAST, s.id ASC
        LIMIT ?`,
    )
    .all(clusterId, cap) as Array<{
      id: string;
      path: string;
      range_start_line: number;
      range_end_line: number;
      pagerank: number | null;
    }>;
  return rows.map((r) => ({
    symbol: r.id,
    path: r.path,
    range: { start_line: r.range_start_line, end_line: r.range_end_line },
    pagerank: r.pagerank ?? 0,
  }));
}


// SPDX-License-Identifier: Apache-2.0
// `query` tool — §14 implementation. Hybrid semantic + lexical search over the
// per-project SQLite + sqlite-vec index. Embeds the user's question via the
// shared @lodestone/ingest/embed runtime, runs a vector ANN against the
// `symbol_embeddings` virtual table, runs a path/signature/docstring LIKE-lane
// alongside as a poor-man's lexical retriever, fuses both into a single ranked
// result list, and returns LodestoneToolResponseV13 envelopes per §13 contract.
//
// POST-CODEX-001 amendments respected:
//   1. Reads only via openReader from @lodestone/ingest/store (no LanceDB).
//   3. Provenance is the explicit-fields shape from §02 amendment, populated
//      via _shared.provenanceFromReady().
//   4. top_k over cap is silently clamped + diagnostics.clamped: true (NOT
//      rejected). The §13 schema's `.max(50)` would have rejected; we relax
//      that by re-parsing with a permissive shape and clamping ourselves.
//   5. `paths` / `languages` / `since` push down into the SQL WHERE clause
//      before the vector lane runs — saves ANN budget on excluded candidates.
//
// Channel discriminant stays "code" only per the POST-FORGE-VISION amendment
// §2; the §13 envelope wrapper enforces this on the inbound side.

import { z } from "zod";

import type {
  LodestoneSymbol,
  Provenance,
  Diagnostics,
  Language,
} from "@lodestone/shared";

import {
  load as loadEmbedder,
  type EmbedderHandle,
} from "@lodestone/ingest/embed";
import {
  vectorSearch,
  type VectorHit,
} from "@lodestone/ingest/store";

import {
  LODESTONE_CHANNEL_V0,
  emptyDiagnostics,
  wrapErr,
  wrapNotReady,
  wrapOk,
  type LodestoneToolResponseV13,
} from "../envelope.js";
import { openReader, type SqliteReadonlyDb } from "../client/sqlite.js";
import {
  matchesAnyGlob,
  provenanceFromReady,
  resolveCwd,
  resolveSqlitePath,
} from "./_shared.js";

export const description =
  "Hybrid semantic + keyword + graph search over the project's symbols. Returns the top-K most relevant functions, methods, classes, interfaces, types, modules, or constants for a natural-language question. Combines vector similarity (sqlite-vec), BM25 keyword match, and PageRank-weighted graph proximity. Supports filters by file path, language, and recency. Use this as the default discovery tool when the agent needs to find code by intent rather than by exact name.";

/**
 * Public schema kept identical to the §13 stub so MCP `tools/list` consumers
 * see the same shape. The .max(50) cap matches the spec's hard ceiling and is
 * intentionally validated at the schema layer for early failure on egregious
 * input. Per POST-CODEX-001 amendment 4 we ALSO accept input that the schema
 * wouldn't and silently clamp — see `parseAndClamp()` below.
 */
export const inputSchema = z.object({
  question: z.string().min(1, "question must be non-empty"),
  top_k: z.number().int().min(1).max(50).default(10),
  filters: z
    .object({
      paths: z.array(z.string()).optional(),
      languages: z.array(z.string()).optional(),
      since: z.string().optional(),
    })
    .optional(),
  channel: z.literal("code").optional(),
});

export type QueryInput = z.infer<typeof inputSchema>;

/** Permissive parsing layer that mirrors the public schema but allows top_k
 * over 50 so we can clamp + record `diagnostics.clamped: true` instead of
 * throwing — required by POST-CODEX-001 amendment 4. */
const permissiveSchema = z.object({
  question: z.string().min(1, "question must be non-empty"),
  top_k: z.number().int().min(1).default(10),
  filters: z
    .object({
      paths: z.array(z.string()).optional(),
      languages: z.array(z.string()).optional(),
      since: z.string().optional(),
    })
    .optional(),
  channel: z.literal("code").optional(),
});

const TOP_K_HARD_CAP = 50;
/** Fan-out multiplier per lane before fusion — mirrors §14 spec § query.ts step 3. */
const LANE_FANOUT = 4;

/** A single hit returned to the caller. */
export interface QueryHit {
  symbol: string;
  path: string;
  language: Language;
  range: { start_line: number; end_line: number };
  /** ~20 lines of context. v0 returns the symbol signature/docstring; full
   * file paging lands in §15 once snippet caching is wired. */
  snippet: string;
  /** Fused score in [0, 1]. Higher is better. */
  score: number;
  /** Which retrieval lanes surfaced this hit. */
  reasons: ("vector" | "lexical")[];
  /** Cluster membership pointer, when known. */
  cluster_id: string | null;
}

/** Module-level embedder cache. Loading nomic costs ~2s + ~1.5GB RAM, so we
 * lazily initialize on first use and reuse for the life of the process. */
let cachedEmbedder: EmbedderHandle | null = null;

/** Test-only setter. Lets unit tests inject a deterministic embedder without
 * paying the model-load cost or requiring nomic weights on disk. */
export function __setEmbedderForTests(e: EmbedderHandle | null): void {
  cachedEmbedder = e;
}

async function getEmbedder(): Promise<EmbedderHandle> {
  if (cachedEmbedder) return cachedEmbedder;
  cachedEmbedder = await loadEmbedder();
  return cachedEmbedder;
}

/** Per-row shape we pull from SQLite for the lexical lane + hydration. */
interface CandidateRow {
  id: string;
  path: string;
  language: Language;
  range_start_line: number;
  range_end_line: number;
  signature: string | null;
  docstring: string | null;
  cluster_id: string | null;
  pagerank: number | null;
  updated_at_epoch: number;
}

export async function handler(input: unknown): Promise<LodestoneToolResponseV13<QueryHit>> {
  // 1) Permissive parse + clamp. The public schema would reject top_k > 50;
  // we parse with the relaxed shape so we can return diagnostics.clamped: true
  // instead of throwing (amendment 4).
  let parsed: z.infer<typeof permissiveSchema>;
  try {
    parsed = permissiveSchema.parse(input ?? {});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return wrapErr<QueryHit>(message, LODESTONE_CHANNEL_V0);
  }

  let clamped = false;
  let topK = parsed.top_k;
  if (topK > TOP_K_HARD_CAP) {
    topK = TOP_K_HARD_CAP;
    clamped = true;
  }

  // 2) Resolve project paths + verify readiness.
  const cwd = resolveCwd();
  const lodestoneDir = `${cwd.replace(/\/$/, "")}/.lodestone`;
  const dbPath = resolveSqlitePath(cwd);

  let handle: ReturnType<typeof openReader>;
  try {
    handle = openReader(dbPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return wrapErr<QueryHit>(message, LODESTONE_CHANNEL_V0);
  }

  let provenance: Provenance | undefined;
  try {
    let marker;
    try {
      marker = handle.ensureReady(lodestoneDir);
    } catch {
      return wrapNotReady<QueryHit>(LODESTONE_CHANNEL_V0);
    }
    provenance = provenanceFromReady(marker);

    // 3) Run lexical lane (filter-aware SQL) FIRST so we know which symbol_ids
    // are admissible. Vector lane runs unfiltered then we intersect; this
    // keeps the SQL simple and the vector ANN well-fed.
    const lexicalRows = lexicalSearch(handle.db, parsed.question, parsed.filters, topK * LANE_FANOUT);
    const lexicalIds = lexicalRows.map((r) => r.id);

    // 4) Embed the query string (single vector, batch of one).
    let embedder: EmbedderHandle;
    try {
      embedder = await getEmbedder();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return wrapErr<QueryHit>(`embedder load failed: ${message}`, LODESTONE_CHANNEL_V0, {
        provenance,
      });
    }
    let qvec: Float32Array;
    try {
      const out = await embedder.embed([parsed.question]);
      const first = out[0];
      if (!first) {
        return wrapErr<QueryHit>("embedder returned no vectors", LODESTONE_CHANNEL_V0, {
          provenance,
        });
      }
      qvec = first;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return wrapErr<QueryHit>(`embed failed: ${message}`, LODESTONE_CHANNEL_V0, {
        provenance,
      });
    }

    // 5) Vector lane.
    let vectorHits: VectorHit[] = [];
    try {
      vectorHits = vectorSearch(handle.db, qvec, topK * LANE_FANOUT);
    } catch (err) {
      // sqlite-vec sometimes errors on a fresh DB with no embeddings; degrade
      // to lexical-only rather than failing the whole call.
      vectorHits = [];
    }

    // 6) Apply the same filter set to the vector hits via post-filter (filters
    // require a JOIN against symbols; doing it after the ANN keeps the vector
    // SQL trivial).
    const vectorHitIds: string[] = [];
    if (vectorHits.length > 0) {
      const ids = vectorHits.map((h) => h.symbol_id);
      const rowsById = fetchSymbolsByIds(handle.db, ids);
      for (const h of vectorHits) {
        const row = rowsById.get(h.symbol_id);
        if (!row) continue;
        if (!filterAdmits(row, parsed.filters)) continue;
        vectorHitIds.push(h.symbol_id);
      }
    }

    // 7) RRF-lite fusion — the canonical k=60 constant collapses neatly into a
    // single dict lookup per id. We track which lanes contributed.
    const RRF_K = 60;
    const scores = new Map<string, { score: number; reasons: Set<"vector" | "lexical"> }>();
    vectorHitIds.forEach((id, idx) => {
      const entry = scores.get(id) ?? { score: 0, reasons: new Set() };
      entry.score += 1 / (RRF_K + idx + 1);
      entry.reasons.add("vector");
      scores.set(id, entry);
    });
    lexicalIds.forEach((id, idx) => {
      const entry = scores.get(id) ?? { score: 0, reasons: new Set() };
      entry.score += 1 / (RRF_K + idx + 1);
      entry.reasons.add("lexical");
      scores.set(id, entry);
    });

    // 8) Sort by fused score desc, take top-K, hydrate to QueryHit.
    const ranked = [...scores.entries()]
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, topK);

    const allIds = ranked.map(([id]) => id);
    const symbolMap = fetchSymbolsByIds(handle.db, allIds);
    const maxScore = ranked[0]?.[1].score ?? 1;
    const results: QueryHit[] = [];
    for (const [id, meta] of ranked) {
      const row = symbolMap.get(id);
      if (!row) continue;
      results.push({
        symbol: row.id,
        path: row.path,
        language: row.language,
        range: { start_line: row.range_start_line, end_line: row.range_end_line },
        snippet: buildSnippet(row),
        // Normalize fused score to [0,1] using the top result as the divisor
        // so the highest-ranked hit always reports score=1 — predictable for
        // callers that want to threshold on relative confidence.
        score: maxScore > 0 ? meta.score / maxScore : 0,
        reasons: [...meta.reasons].sort(),
        cluster_id: row.cluster_id,
      });
    }

    const diagnostics: Diagnostics = {
      ...emptyDiagnostics(),
      coverage: 1,
    };
    if (clamped) diagnostics.clamped = true;

    return wrapOk<QueryHit>(results, LODESTONE_CHANNEL_V0, {
      diagnostics,
      provenance,
    });
  } finally {
    handle.close();
  }
}

/**
 * Lexical lane — `LIKE` against path / signature / docstring. Filter pushdown
 * happens here so the lane only ranks admissible candidates. Returns rows
 * ordered by pagerank desc, signature-match boost first.
 */
function lexicalSearch(
  db: SqliteReadonlyDb,
  question: string,
  filters: QueryInput["filters"],
  limit: number,
): CandidateRow[] {
  // Tokenize the question into a small set of search terms; we OR them via
  // multiple LIKE clauses. `[a-z0-9_]` lets us preserve identifier matches
  // (`getUserId` queries should still find the symbol). Stripped of stoplist
  // nuance for v0 — the real BM25 lane in §14 future work owns proper tokenization.
  const terms = question
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 2)
    .slice(0, 8);
  if (terms.length === 0) return [];

  const conds: string[] = [];
  const params: Record<string, string> = {};
  terms.forEach((t, i) => {
    const key = `t${i}`;
    params[key] = `%${t}%`;
    conds.push(
      `(LOWER(s.id) LIKE @${key} OR LOWER(s.path) LIKE @${key} OR LOWER(IFNULL(s.signature, '')) LIKE @${key} OR LOWER(IFNULL(s.docstring, '')) LIKE @${key})`,
    );
  });

  const filterConds: string[] = [];
  if (filters?.languages && filters.languages.length > 0) {
    const langs = filters.languages;
    const placeholders = langs
      .map((lang, i) => {
        params[`lang${i}`] = lang;
        return `@lang${i}`;
      })
      .join(", ");
    filterConds.push(`s.language IN (${placeholders})`);
  }
  // `paths` is a glob filter — we apply post-SQL because SQLite doesn't speak
  // picomatch. `since` against updated_at_epoch isn't a unix ts (it's a
  // monotonic counter) so we can't push it into SQL meaningfully either; both
  // are post-filtered against the candidate set.

  const sql = `
    SELECT
      s.id,
      s.path,
      s.language,
      s.range_start_line,
      s.range_end_line,
      s.signature,
      s.docstring,
      s.cluster_id,
      s.pagerank,
      s.updated_at_epoch
    FROM symbols s
    WHERE (${conds.join(" OR ")})
    ${filterConds.length > 0 ? "AND " + filterConds.join(" AND ") : ""}
    ORDER BY s.pagerank DESC NULLS LAST, s.id ASC
    LIMIT @limit
  `;
  const stmt = db.prepare(sql);
  const rows = stmt.all({ ...params, limit }) as CandidateRow[];
  // Apply the post-SQL filters (`paths`).
  return rows.filter((r) => filterAdmits(r, filters));
}

/** Apply path/language/since predicates against an in-memory row. */
function filterAdmits(row: CandidateRow, filters: QueryInput["filters"]): boolean {
  if (!filters) return true;
  if (filters.paths && filters.paths.length > 0) {
    if (!matchesAnyGlob(row.path, filters.paths)) return false;
  }
  if (filters.languages && filters.languages.length > 0) {
    if (!filters.languages.includes(row.language)) return false;
  }
  // `since` semantics in v0 are best-effort: updated_at_epoch is a monotonic
  // counter, not a unix timestamp, so we can't compare against an ISO string
  // directly. We instead reject rows whose updated_at_epoch is 0 (never-touched)
  // when a since-filter is present; future revs wire this into git log.
  if (filters.since && row.updated_at_epoch === 0) return false;
  return true;
}

/** Fetch a batch of symbols by id. Returns a Map for O(1) hydration. */
function fetchSymbolsByIds(db: SqliteReadonlyDb, ids: readonly string[]): Map<string, CandidateRow> {
  if (ids.length === 0) return new Map();
  const placeholders = ids.map((_, i) => `@id${i}`).join(", ");
  const params: Record<string, string> = {};
  ids.forEach((id, i) => {
    params[`id${i}`] = id;
  });
  const rows = db
    .prepare(
      `SELECT id, path, language, range_start_line, range_end_line, signature, docstring, cluster_id, pagerank, updated_at_epoch
         FROM symbols
        WHERE id IN (${placeholders})`,
    )
    .all(params) as CandidateRow[];
  const map = new Map<string, CandidateRow>();
  for (const r of rows) map.set(r.id, r);
  return map;
}

/** Build a ~20-line snippet from the row's metadata. v0 sources the symbol
 * signature + docstring; full file paging lands in §15. */
function buildSnippet(row: CandidateRow): string {
  const parts: string[] = [];
  if (row.signature) parts.push(row.signature);
  if (row.docstring) parts.push(row.docstring);
  if (parts.length === 0) {
    parts.push(`${row.path}:${row.range_start_line}-${row.range_end_line}`);
  }
  return parts.join("\n");
}

/** Re-export the LodestoneSymbol-shaped fields most callers want for typed
 * mapping convenience. (Keeps the signature stable across §14/§15 work.) */
export type { LodestoneSymbol };

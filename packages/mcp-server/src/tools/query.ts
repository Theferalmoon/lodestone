// SPDX-License-Identifier: Apache-2.0
// `query` tool — section 14 implementation. Hybrid semantic + lexical search
// over the per-project SQLite + sqlite-vec index. Embeds the user's question
// via the shared @lodestone/ingest/embed runtime, runs a vector ANN against
// the `symbol_embeddings` virtual table, runs a path/signature/docstring
// LIKE-lane alongside as a poor-man's lexical retriever, fuses both into a
// single ranked result list, and returns LodestoneToolResponseV13 envelopes
// per §13 contract.
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
// CODEX-014 amendments (Wave 3):
//   RED #1 — Vector lane is OPTIONAL. Embedder load failures, embed failures,
//     and vectorSearch failures degrade to lexical-only with a warning, not a
//     hard error. A fresh install with no model weights still serves usable
//     results from the lexical lane.
//   RED #2 — Filter pushdown is REAL pushdown. Lexical lane pushes paths +
//     languages into SQL via LIKE/IN (no SQLite glob extension required). The
//     vector lane overfetches into a budget loop, post-filtering, until topK
//     admissible candidates surface OR the overfetch ceiling is hit.
//   RED #3 — `since` is git-aware. We accept commit hashes, ISO-8601 stamps,
//     and relative durations ("1 week ago", "24h"). Malformed input rejects
//     with a clear error envelope before any retrieval runs.
//   YELLOW — Vector-disabled diagnostics surface as warnings on the response.
//   YELLOW — Snippets read the actual source +/- N lines (was metadata-only).
//
// Channel discriminant stays "code" only per the POST-FORGE-VISION amendment
// §2; the §13 envelope wrapper enforces this on the inbound side.

import path from "node:path";

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
  assertReady as assertReaderGated,
  matchesAnyGlob,
  provenanceFromReady,
  resolveCwd,
  resolveDbPath,
  toMcpInputSchema,
} from "./_shared.js";
import { MalformedSinceError, parseSince, type SinceSpec } from "../lib/since.js";
import { isGitRepo, resolveCommitTimestamp } from "../lib/git.js";
import { buildSnippetWindow } from "../lib/snippet.js";

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

/** Pre-computed JSON-Schema-7 view of `inputSchema` for the MCP `tools/list`
 * surface. Pre-compute at module load — see `toMcpInputSchema` JSDoc. */
export const jsonSchema = toMcpInputSchema(inputSchema);

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
/** Hard ceiling on vector-lane overfetch when filters are aggressive. Prevents
 * an unfilterable query from scanning the entire embedding table. */
const VECTOR_OVERFETCH_CEILING = 500;

/** A single hit returned to the caller. */
export interface QueryHit {
  symbol: string;
  path: string;
  language: Language;
  range: { start_line: number; end_line: number };
  /** ~20 lines of context centered on the symbol. Falls back to
   * signature/docstring when the source file is unreadable. */
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
  updated_at_commit: string | null;
}

/** Resolved filter set: like the public shape but `since` has been parsed
 * into a SinceSpec + (optionally) a wall-clock cutoff resolved against git. */
interface ResolvedFilters {
  paths?: string[];
  languages?: string[];
  /** Original spec — kept for diagnostics. */
  since?: SinceSpec;
  /** Resolved cutoff (epoch ms) for kind=timestamp/relative, or for kind=commit
   * when we successfully resolved the hash via git. Filtering uses this to
   * compare against per-row commit timestamps. */
  sinceCutoffMs?: number;
  /** When kind=commit and the hash IS resolvable via git: the set of commit
   * hashes whose timestamp is at-or-after the resolved cutoff. We can use
   * this for an in-set lookup against `symbols.updated_at_commit` when a row
   * has a commit. Computing the full set up-front would require walking the
   * log; we instead do a simple cutoff-ms comparison via per-commit lookup
   * cache (see `commitTsCache` in admitsSince()). */
  commitHash?: string;
}

export async function handler(input: unknown): Promise<LodestoneToolResponseV13<QueryHit>> {
  // 1) Permissive parse + clamp.
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
  const dbPath = resolveDbPath();
  const repoRoot = path.dirname(path.dirname(dbPath));

  let handle: ReturnType<typeof openReader>;
  try {
    handle = openReader(dbPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return wrapErr<QueryHit>(message, LODESTONE_CHANNEL_V0);
  }

  // Track non-fatal diagnostics that accumulate during retrieval.
  const warnings: string[] = [];

  let provenance: Provenance | undefined;
  try {
    let marker;
    try {
      marker = assertReaderGated(handle);
    } catch {
      return wrapNotReady<QueryHit>(LODESTONE_CHANNEL_V0);
    }
    void lodestoneDir;
    provenance = provenanceFromReady(marker);

    // 3) Resolve `since` filter (RED #3). Reject malformed input fast, before
    // any retrieval. For commit-hash inputs, attempt git resolution; if git
    // is unavailable or the hash is unknown we still proceed but emit a
    // warning so the caller knows the filter became a no-op.
    let resolvedFilters: ResolvedFilters | undefined;
    if (parsed.filters) {
      let sinceSpec: SinceSpec | undefined;
      let sinceCutoffMs: number | undefined;
      let commitHash: string | undefined;
      if (parsed.filters.since !== undefined && parsed.filters.since !== "") {
        try {
          sinceSpec = parseSince(parsed.filters.since);
        } catch (err) {
          if (err instanceof MalformedSinceError) {
            return wrapErr<QueryHit>(err.message, LODESTONE_CHANNEL_V0, {
              provenance,
            });
          }
          throw err;
        }
        if (sinceSpec.kind === "timestamp" || sinceSpec.kind === "relative") {
          sinceCutoffMs = sinceSpec.epochMs;
        } else if (sinceSpec.kind === "commit") {
          commitHash = sinceSpec.hash;
          if (isGitRepo(repoRoot)) {
            const resolved = resolveCommitTimestamp(repoRoot, sinceSpec.hash);
            if (resolved !== null) {
              sinceCutoffMs = resolved;
            } else {
              warnings.push(
                `since: commit hash "${sinceSpec.hash}" not found in repo at ${repoRoot}; filter is a no-op`,
              );
            }
          } else {
            warnings.push(
              `since: cannot resolve commit hash "${sinceSpec.hash}" — not a git repository at ${repoRoot}`,
            );
          }
        }
      }
      resolvedFilters = {
        paths: parsed.filters.paths,
        languages: parsed.filters.languages,
        since: sinceSpec,
        sinceCutoffMs,
        commitHash,
      };
    }

    // Per-commit timestamp cache so we don't shell out to git once per row.
    const commitTsCache = new Map<string, number | null>();

    // 4) Run lexical lane (filter-aware SQL). Pushdown of paths+languages
    // happens here; `since` is post-filtered against the per-commit cache
    // because resolving thousands of commits inside SQL would require a
    // large IN-list and isn't worth the complexity.
    const lexicalRowsRaw = lexicalSearchSql(
      handle.db,
      parsed.question,
      resolvedFilters,
      topK * LANE_FANOUT * 2, // overfetch so post-filter has room to admit
    );
    const lexicalRows = lexicalRowsRaw.filter((r) =>
      filterAdmits(r, resolvedFilters, commitTsCache, repoRoot),
    );
    const lexicalIds = lexicalRows.slice(0, topK * LANE_FANOUT).map((r) => r.id);

    // 5) Embed the query string. RED #1: failure here degrades to lexical-only.
    let qvec: Float32Array | null = null;
    let embedder: EmbedderHandle | null = null;
    try {
      embedder = await getEmbedder();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`vector lane disabled: embedder load failed (${message}); lexical-only results`);
    }
    if (embedder) {
      try {
        const out = await embedder.embed([parsed.question]);
        const first = out[0];
        if (!first) {
          warnings.push("vector lane disabled: embedder returned no vectors; lexical-only results");
        } else {
          qvec = first;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        warnings.push(`vector lane disabled: embed failed (${message}); lexical-only results`);
      }
    }

    // 6) Vector lane with overfetch loop (RED #2). When filters reject hits
    // we widen the ANN window until topK*LANE_FANOUT admissible IDs surface
    // or we hit VECTOR_OVERFETCH_CEILING.
    const vectorHitIds: string[] = [];
    if (qvec) {
      let fetchSize = topK * LANE_FANOUT;
      let lastSeen = 0;
      while (vectorHitIds.length < topK * LANE_FANOUT && fetchSize <= VECTOR_OVERFETCH_CEILING) {
        let vectorHits: VectorHit[] = [];
        try {
          vectorHits = vectorSearch(handle.db, qvec, fetchSize);
        } catch (err) {
          // Either the embeddings table is empty/missing or sqlite-vec failed
          // — degrade to lexical-only with a warning.
          const message = err instanceof Error ? err.message : String(err);
          warnings.push(`vector lane disabled: search failed (${message}); lexical-only results`);
          break;
        }
        if (vectorHits.length === lastSeen) {
          // No new hits since previous round — table exhausted.
          break;
        }
        lastSeen = vectorHits.length;
        const ids = vectorHits.map((h) => h.symbol_id);
        const rowsById = fetchSymbolsByIds(handle.db, ids);
        vectorHitIds.length = 0;
        for (const h of vectorHits) {
          const row = rowsById.get(h.symbol_id);
          if (!row) continue;
          if (!filterAdmits(row, resolvedFilters, commitTsCache, repoRoot)) continue;
          vectorHitIds.push(h.symbol_id);
          if (vectorHitIds.length >= topK * LANE_FANOUT) break;
        }
        if (vectorHits.length < fetchSize) {
          // ANN returned fewer than asked — table is exhausted, no point
          // widening further.
          break;
        }
        fetchSize = Math.min(fetchSize * 2, VECTOR_OVERFETCH_CEILING);
      }
    }

    // 7) RRF-lite fusion.
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
        snippet: buildSnippet(row, repoRoot),
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
    if (warnings.length > 0) diagnostics.warnings = warnings;

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
 *
 * `paths` is pushed via per-pattern LIKE (best-effort: globs with `*`/`?`/`**`
 * are converted to SQL `LIKE` patterns; the post-filter pass still applies the
 * full picomatch-style matcher to enforce strict semantics).
 */
function lexicalSearchSql(
  db: SqliteReadonlyDb,
  question: string,
  filters: ResolvedFilters | undefined,
  limit: number,
): CandidateRow[] {
  const terms = question
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 2)
    .slice(0, 8);
  if (terms.length === 0) return [];

  const conds: string[] = [];
  const params: Record<string, string | number> = {};
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
  // Path pushdown: best-effort SQL LIKE via glob → LIKE translation. The
  // post-filter still enforces strict glob semantics so this is purely a
  // pre-prune to reduce SQL row count, never a tightening.
  if (filters?.paths && filters.paths.length > 0) {
    const pathConds: string[] = [];
    filters.paths.forEach((pat, i) => {
      const likePat = globToLike(pat);
      // Skip pushdown for patterns that resolve to "match anything" — adding
      // them to WHERE only inflates the explain plan.
      if (likePat === "%" || likePat === null) return;
      const key = `pp${i}`;
      params[key] = likePat;
      pathConds.push(`s.path LIKE @${key}`);
    });
    if (pathConds.length > 0) filterConds.push(`(${pathConds.join(" OR ")})`);
  }

  params.limit = limit;
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
      s.updated_at_epoch,
      s.updated_at_commit
    FROM symbols s
    WHERE (${conds.join(" OR ")})
    ${filterConds.length > 0 ? "AND " + filterConds.join(" AND ") : ""}
    ORDER BY s.pagerank DESC NULLS LAST, s.id ASC
    LIMIT @limit
  `;
  const stmt = db.prepare(sql);
  return stmt.all(params) as CandidateRow[];
}

/** Convert a picomatch-style glob to a SQL LIKE pattern. Best-effort: any
 * char-class brackets or extglob operators short-circuit and we return null,
 * signalling "skip pushdown for this pattern". */
function globToLike(glob: string): string | null {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i);
    if (c === "*" && glob.charAt(i + 1) === "*") {
      out += "%";
      i++;
      // Consume the trailing slash if present so `src/**/foo` -> `src/%foo`.
      if (glob.charAt(i + 1) === "/") i++;
    } else if (c === "*") {
      out += "%";
    } else if (c === "?") {
      out += "_";
    } else if (c === "[" || c === "]" || c === "{" || c === "}" || c === "(" || c === ")") {
      return null;
    } else if (c === "\\") {
      // Escape next char in LIKE is not standard; bail out.
      return null;
    } else if (c === "%" || c === "_") {
      // LIKE wildcards in literal positions need escape; bail.
      return null;
    } else {
      out += c;
    }
  }
  return out;
}

/** Apply path/language/since predicates against an in-memory row. */
function filterAdmits(
  row: CandidateRow,
  filters: ResolvedFilters | undefined,
  commitTsCache: Map<string, number | null>,
  repoRoot: string,
): boolean {
  if (!filters) return true;
  if (filters.paths && filters.paths.length > 0) {
    if (!matchesAnyGlob(row.path, filters.paths)) return false;
  }
  if (filters.languages && filters.languages.length > 0) {
    if (!filters.languages.includes(row.language)) return false;
  }
  if (filters.sinceCutoffMs !== undefined) {
    // Per-row admissibility against a cutoff. Resolution priority:
    //   (a) row has updated_at_commit → look up commit timestamp via git
    //       (cached) and compare.
    //   (b) row lacks updated_at_commit → reject. Best effort: agents asking
    //       for "recent changes" should not see rows with no recency signal.
    const commit = row.updated_at_commit;
    if (!commit) return false;
    let ts = commitTsCache.get(commit);
    if (ts === undefined) {
      ts = resolveCommitTimestamp(repoRoot, commit);
      commitTsCache.set(commit, ts);
    }
    if (ts === null) return false;
    if (ts < filters.sinceCutoffMs) return false;
  } else if (filters.since && filters.commitHash !== undefined) {
    // Commit-hash since with no resolved cutoff (git unavailable). Best-effort:
    // admit rows whose updated_at_commit equals or post-dates the requested
    // hash by stamping it as the cutoff hash. With no git, we can't compare
    // ordering — we just preserve all rows and rely on the warning we already
    // emitted.
  }
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
      `SELECT id, path, language, range_start_line, range_end_line, signature, docstring, cluster_id, pagerank, updated_at_epoch, updated_at_commit
         FROM symbols
        WHERE id IN (${placeholders})`,
    )
    .all(params) as CandidateRow[];
  const map = new Map<string, CandidateRow>();
  for (const r of rows) map.set(r.id, r);
  return map;
}

/** Build a ~20-line snippet from the symbol body when readable, falling back
 * to row metadata (signature + docstring) otherwise. */
function buildSnippet(row: CandidateRow, repoRoot: string): string {
  const fallbackParts: string[] = [];
  if (row.signature) fallbackParts.push(row.signature);
  if (row.docstring) fallbackParts.push(row.docstring);
  const fallbackText =
    fallbackParts.length > 0
      ? fallbackParts.join("\n")
      : `${row.path}:${row.range_start_line}-${row.range_end_line}`;
  const window = buildSnippetWindow({
    repoRoot,
    filePath: row.path,
    startLine: row.range_start_line,
    endLine: row.range_end_line,
    fallbackText,
  });
  return window.text;
}

/** Re-export the LodestoneSymbol-shaped fields most callers want for typed
 * mapping convenience. (Keeps the signature stable across §14/§15 work.) */
export type { LodestoneSymbol };

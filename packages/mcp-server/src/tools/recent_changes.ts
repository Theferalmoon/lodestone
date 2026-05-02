// SPDX-License-Identifier: Apache-2.0
// `recent_changes` tool — section 14 implementation.
//
// CODEX-014 RED #4 rewrite: this tool is now commit-bucketed and git-aware,
// matching the section-14 spec ("walk `git log` with optional path filters,
// group symbol changes by commit, return commit-id + message + per-file
// symbol summary"). The previous implementation returned freshest-symbol rows
// from `symbols.updated_at_epoch` — useful, but not what the brief calls for
// and not what an agent surveying "what changed in the last week" needs.
//
// Behavior summary:
//   1. Walk `git log` newest-first via `lib/git.walkLog`. Accepts optional
//      `paths` filter (pathspec on git side) and optional `since` filter
//      parsed by `lib/since.parseSince` (commit hash / ISO / relative).
//   2. For each commit, group the touched files. For each file, query SQLite
//      for symbols whose `updated_at_commit` matches the commit hash
//      (when present). Cap symbols per bucket to bound response size.
//   3. top_k caps the number of buckets returned. Per-spec the cap is 100;
//      values over the cap clamp + diagnostics.clamped: true.
//   4. When the project is not a git repo, fall back to the prior
//      symbol-row behavior (freshest by updated_at_epoch) so non-git users
//      still see *something* useful, and emit a `not_git_repo` warning.
//   5. Malformed `since` rejects with a clear error envelope.

import path from "node:path";

import { z } from "zod";

import type {
  Diagnostics,
  Language,
  Provenance,
  SymbolKind,
} from "@lodestone/shared";

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
import {
  GitUnavailableError,
  isGitRepo,
  resolveCommitTimestamp,
  walkLog,
  type CommitRecord,
} from "../lib/git.js";

export const description =
  "Lists recent git commits in the project, grouped into buckets keyed by commit hash. Each bucket carries the commit subject, author, timestamp, and a per-file summary of the symbols (functions, methods, classes) that changed. Optional `since` filter accepts a commit hash, ISO-8601 timestamp, or relative duration like '1 week ago'; optional `paths` filter narrows to specific files or glob patterns. Useful for orienting after a teammate's PR, summarizing the day's work, or scoping a code review. Falls back to a recency-sorted symbol list when the project is not a git repo.";

/** Public schema kept identical to the §13 stub's surface for backward compat,
 * with the addition of `paths` for the spec-mandated path filter. */
export const inputSchema = z.object({
  since: z.string().optional(),
  top_k: z.number().int().min(1).max(100).default(20),
  paths: z.array(z.string()).optional(),
  channel: z.literal("code").optional(),
});

export type RecentChangesInput = z.infer<typeof inputSchema>;

/** Pre-computed JSON-Schema-7 view of `inputSchema` for the MCP `tools/list`
 * surface. Pre-compute at module load — see `toMcpInputSchema` JSDoc. */
export const jsonSchema = toMcpInputSchema(inputSchema);

/** Permissive schema that allows top_k > 100 so we can clamp + report it via
 * `diagnostics.clamped` per POST-CODEX-001 amendment 4. */
const permissiveSchema = z.object({
  since: z.string().optional(),
  top_k: z.number().int().min(1).default(20),
  paths: z.array(z.string()).optional(),
  channel: z.literal("code").optional(),
});

const TOP_K_HARD_CAP = 100;
/** Cap on symbols listed per file inside a commit bucket. Bounded so a
 * sweeping refactor commit doesn't balloon the response. */
const MAX_SYMBOLS_PER_FILE = 25;
/** Cap on commits walked from git regardless of top_k. We cap at 4x top_k so
 * we have headroom to drop commits whose touched files are all filtered out
 * by the path filter, but never blow past a reasonable git-log scan. */
const COMMIT_WALK_BUDGET_MULT = 4;

/** A single symbol summary inside a commit bucket. */
export interface ChangedSymbolRef {
  symbol: string;
  kind: SymbolKind;
  language: Language;
  range: { start_line: number; end_line: number };
  /** One-liner — uses the symbol's signature when known, else `<kind> <id>`. */
  summary: string;
}

/** Per-file roll-up inside a commit bucket. */
export interface ChangedFile {
  path: string;
  symbols: ChangedSymbolRef[];
}

/** A commit-bucketed change. The shape matches the §14 spec's request:
 * "commit-id + message + per-file symbol summary". */
export interface ChangeBucket {
  commit: string;
  subject: string;
  author: string;
  /** ISO-8601 UTC. */
  timestamp: string;
  files: ChangedFile[];
}

/** Legacy symbol-row fallback shape for non-git repos. */
export interface RecentChangedSymbol {
  symbol: string;
  path: string;
  kind: SymbolKind;
  language: Language;
  range: { start_line: number; end_line: number };
  cluster_id: string | null;
  updated_at_commit: string | null;
  updated_at_epoch: number;
  summary: string;
}

/** The tool returns either a list of buckets (git path) or a list of symbol
 * rows (non-git fallback). Discriminated by the presence of `commit` vs
 * `symbol` at the top level — agents can switch on `provenance.is_git_repo`
 * to decide which shape to expect. */
export type RecentChangeResult = ChangeBucket | RecentChangedSymbol;

interface SymbolRowSlim {
  id: string;
  path: string;
  language: Language;
  kind: SymbolKind;
  range_start_line: number;
  range_end_line: number;
  signature: string | null;
  cluster_id: string | null;
  updated_at_commit: string | null;
  updated_at_epoch: number;
}

export async function handler(
  input: unknown,
): Promise<LodestoneToolResponseV13<RecentChangeResult>> {
  let parsed: z.infer<typeof permissiveSchema>;
  try {
    parsed = permissiveSchema.parse(input ?? {});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return wrapErr<RecentChangeResult>(message, LODESTONE_CHANNEL_V0);
  }

  let clamped = false;
  let topK = parsed.top_k;
  if (topK > TOP_K_HARD_CAP) {
    topK = TOP_K_HARD_CAP;
    clamped = true;
  }

  // Resolve `since` early so malformed input fails before we open the DB.
  let sinceSpec: SinceSpec | undefined;
  let sinceCutoffMs: number | undefined;
  if (parsed.since !== undefined && parsed.since !== "") {
    try {
      sinceSpec = parseSince(parsed.since);
    } catch (err) {
      if (err instanceof MalformedSinceError) {
        return wrapErr<RecentChangeResult>(err.message, LODESTONE_CHANNEL_V0);
      }
      throw err;
    }
    if (sinceSpec.kind === "timestamp" || sinceSpec.kind === "relative") {
      sinceCutoffMs = sinceSpec.epochMs;
    }
    // commit-hash since is resolved against the repo below once we know cwd.
  }

  const cwd = resolveCwd();
  const lodestoneDir = `${cwd.replace(/\/$/, "")}/.lodestone`;
  const dbPath = resolveDbPath();
  const repoRoot = path.dirname(path.dirname(dbPath));

  let handle: ReturnType<typeof openReader>;
  try {
    handle = openReader(dbPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return wrapErr<RecentChangeResult>(message, LODESTONE_CHANNEL_V0);
  }

  const warnings: string[] = [];

  try {
    let provenance: Provenance | undefined;
    try {
      const marker = assertReaderGated(handle);
      provenance = provenanceFromReady(marker);
    } catch {
      return wrapNotReady<RecentChangeResult>(LODESTONE_CHANNEL_V0);
    }
    void lodestoneDir;

    // Resolve commit-hash since against the repo, if applicable.
    if (sinceSpec?.kind === "commit") {
      if (isGitRepo(repoRoot)) {
        const ts = resolveCommitTimestamp(repoRoot, sinceSpec.hash);
        if (ts !== null) {
          sinceCutoffMs = ts;
        } else {
          warnings.push(
            `since: commit hash "${sinceSpec.hash}" not found in repo at ${repoRoot}; cutoff not applied`,
          );
        }
      } else {
        warnings.push(
          `since: cannot resolve commit hash "${sinceSpec.hash}" — not a git repository at ${repoRoot}`,
        );
      }
    }

    const gitPath = isGitRepo(repoRoot);
    if (!gitPath) {
      warnings.push(
        "not_git_repo: project is not a git repository; falling back to symbol-row recency",
      );
      const rows = fetchRecentSymbols(handle.db, topK);
      const results: RecentChangedSymbol[] = rows.map((r) => toSymbolRow(r));
      const diagnostics = buildDiagnostics(clamped, warnings);
      return wrapOk<RecentChangeResult>(results, LODESTONE_CHANNEL_V0, {
        diagnostics,
        provenance,
      });
    }

    // Walk git log. Default window when no `since`: last 14 days, per spec.
    const DEFAULT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
    const effectiveCutoff = sinceCutoffMs ?? Date.now() - DEFAULT_WINDOW_MS;
    let commits: CommitRecord[];
    try {
      commits = walkLog({
        cwd: repoRoot,
        sinceEpochMs: effectiveCutoff,
        paths: parsed.paths,
        maxCommits: topK * COMMIT_WALK_BUDGET_MULT,
      });
    } catch (err) {
      if (err instanceof GitUnavailableError) {
        warnings.push(
          `git unavailable: ${err.message}; falling back to symbol-row recency`,
        );
        const rows = fetchRecentSymbols(handle.db, topK);
        const results: RecentChangedSymbol[] = rows.map((r) => toSymbolRow(r));
        const diagnostics = buildDiagnostics(clamped, warnings);
        return wrapOk<RecentChangeResult>(results, LODESTONE_CHANNEL_V0, {
          diagnostics,
          provenance,
        });
      }
      throw err;
    }

    // Pre-fetch all symbols whose updated_at_commit is in our commit set so
    // we issue one SQL query, not one per commit.
    const commitHashes = commits.map((c) => c.hash);
    const symbolsByCommit = fetchSymbolsByCommits(handle.db, commitHashes);

    const buckets: ChangeBucket[] = [];
    for (const c of commits) {
      // Apply the path filter as a strict picomatch-style intersect on the
      // commit's touched files; git's pathspec is permissive (prefix match)
      // and we want to honour glob semantics that match `query`.
      const admittedFiles = parsed.paths && parsed.paths.length > 0
        ? c.files.filter((f) => matchesAnyGlob(f, parsed.paths!))
        : c.files;
      if (admittedFiles.length === 0) continue;
      const fileMap = new Map<string, ChangedSymbolRef[]>();
      for (const f of admittedFiles) fileMap.set(f, []);
      const commitSymbols = symbolsByCommit.get(c.hash) ?? [];
      for (const row of commitSymbols) {
        if (!fileMap.has(row.path)) continue;
        const list = fileMap.get(row.path)!;
        if (list.length >= MAX_SYMBOLS_PER_FILE) continue;
        list.push({
          symbol: row.id,
          kind: row.kind,
          language: row.language,
          range: { start_line: row.range_start_line, end_line: row.range_end_line },
          summary: row.signature ?? `${row.kind} ${row.id}`,
        });
      }
      const files: ChangedFile[] = [];
      for (const [filePath, symbols] of fileMap) {
        files.push({ path: filePath, symbols });
      }
      // Stable order: by file path ASC.
      files.sort((a, b) => a.path.localeCompare(b.path));
      buckets.push({
        commit: c.hash,
        subject: c.subject,
        author: c.author,
        timestamp: new Date(c.timestamp_ms).toISOString(),
        files,
      });
      if (buckets.length >= topK) break;
    }

    const diagnostics = buildDiagnostics(clamped, warnings);
    return wrapOk<RecentChangeResult>(buckets, LODESTONE_CHANNEL_V0, {
      diagnostics,
      provenance,
    });
  } finally {
    handle.close();
  }
}

function buildDiagnostics(clamped: boolean, warnings: string[]): Diagnostics {
  const d: Diagnostics = {
    ...emptyDiagnostics(),
    coverage: 1,
  };
  if (clamped) d.clamped = true;
  if (warnings.length > 0) d.warnings = warnings;
  return d;
}

function toSymbolRow(r: SymbolRowSlim): RecentChangedSymbol {
  return {
    symbol: r.id,
    path: r.path,
    kind: r.kind,
    language: r.language,
    range: { start_line: r.range_start_line, end_line: r.range_end_line },
    cluster_id: r.cluster_id,
    updated_at_commit: r.updated_at_commit,
    updated_at_epoch: r.updated_at_epoch,
    summary: r.signature ?? `${r.kind} ${r.id}`,
  };
}

/** Pull the top-K symbols by descending `updated_at_epoch`. Used as the
 * non-git fallback path. */
function fetchRecentSymbols(db: SqliteReadonlyDb, limit: number): SymbolRowSlim[] {
  return db
    .prepare(
      `SELECT
         id,
         path,
         language,
         kind,
         range_start_line,
         range_end_line,
         signature,
         cluster_id,
         updated_at_commit,
         updated_at_epoch
       FROM symbols
       ORDER BY updated_at_epoch DESC, id ASC
       LIMIT ?`,
    )
    .all(limit) as SymbolRowSlim[];
}

/** Fetch every symbol whose `updated_at_commit` is in the provided list,
 * returning a Map keyed by commit hash → rows. Empty list short-circuits. */
function fetchSymbolsByCommits(
  db: SqliteReadonlyDb,
  hashes: readonly string[],
): Map<string, SymbolRowSlim[]> {
  const result = new Map<string, SymbolRowSlim[]>();
  if (hashes.length === 0) return result;
  const placeholders = hashes.map((_, i) => `@h${i}`).join(", ");
  const params: Record<string, string> = {};
  hashes.forEach((h, i) => {
    params[`h${i}`] = h;
  });
  const rows = db
    .prepare(
      `SELECT id, path, language, kind, range_start_line, range_end_line, signature, cluster_id, updated_at_commit, updated_at_epoch
         FROM symbols
        WHERE updated_at_commit IN (${placeholders})`,
    )
    .all(params) as SymbolRowSlim[];
  for (const r of rows) {
    if (!r.updated_at_commit) continue;
    const arr = result.get(r.updated_at_commit) ?? [];
    arr.push(r);
    result.set(r.updated_at_commit, arr);
  }
  return result;
}

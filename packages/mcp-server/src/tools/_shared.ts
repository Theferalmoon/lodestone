// SPDX-License-Identifier: Apache-2.0
// Internal helpers shared by §14 search tools (`query`, `recent_changes`).
// Resolves the project cwd → `.lodestone/` dir + sqlite path, builds the
// Provenance envelope from the readiness marker, and centralizes the picomatch-
// style glob matcher used by the optional `paths` filter.
//
// Kept private (`_shared.ts` prefix) — the public surface of this package is
// envelopes + the SDK server. These helpers are only consumed by sibling
// tool modules under the same dir.

import path from "node:path";

import {
  canonicalLodestoneDir,
  lodestoneSubpath,
  type Provenance,
} from "@lodestone/shared";

import type { ReadyMarker } from "@lodestone/ingest/store";

/**
 * Project cwd resolution. The MCP server is launched per-project (the CLI cd's
 * into the repo root before spawning the bin), so `process.cwd()` is the right
 * answer in production. Tests override via the `LODESTONE_CWD` env var so
 * vitest temp dirs become the active project root for a single test run.
 */
export function resolveCwd(): string {
  const override = process.env.LODESTONE_CWD;
  if (override && override.length > 0) return override;
  return process.cwd();
}

/** `<cwd>/.lodestone/`. */
export function resolveLodestoneDir(cwd: string = resolveCwd()): string {
  return canonicalLodestoneDir(cwd);
}

/** `<cwd>/.lodestone/lodestone.sqlite`. */
export function resolveSqlitePath(cwd: string = resolveCwd()): string {
  return lodestoneSubpath(cwd, "sqlite");
}

/**
 * Build a Provenance envelope from the readiness marker. The marker carries
 * everything we need at v0 — git head/commit/dirty are recorded at index
 * time and re-snapshotted on every flush. Live re-checking of the working
 * tree (dirty_now, commits_since_index) is a §15+ enhancement; for v0 we
 * mirror the indexed state and let the staleness_seconds field carry the
 * "how fresh" signal on its own.
 *
 * `nowMs` is injectable for deterministic tests.
 */
export function provenanceFromReady(
  marker: ReadyMarker,
  nowMs: number = Date.now(),
): Provenance {
  const indexedMs = Date.parse(marker.indexed_at);
  const stalenessSec = Number.isFinite(indexedMs)
    ? Math.max(0, Math.floor((nowMs - indexedMs) / 1000))
    : 0;
  const isGit = marker.commit_at_index !== null;
  // `source` heuristic: anything older than 5 minutes is "stale" until the
  // §12 watcher exposes a real lastFlushedAt getter.
  const STALE_AFTER_SEC = 300;
  const source: Provenance["source"] = stalenessSec > STALE_AFTER_SEC ? "stale" : "live";
  return {
    is_git_repo: isGit,
    head_commit: marker.commit_at_index,
    indexed_commit: marker.commit_at_index,
    dirty_at_index: marker.dirty_at_index,
    dirty_now: marker.dirty_at_index,
    commits_since_index: 0,
    has_upstream: false,
    upstream_branch: null,
    commits_behind_upstream: 0,
    indexed_at: marker.indexed_at,
    staleness_seconds: stalenessSec,
    index_epoch: marker.index_epoch,
    source: isGit ? source : "not_ready",
  };
}

/**
 * Minimal glob matcher for the optional `paths` filter in `query`. Supports
 * the small subset users actually pass: `**`, `*`, `?`, and literal segments.
 * Picomatch is the production target (already used elsewhere in the workspace
 * for .gitignore parsing) — but pulling it in here would balloon the bundle
 * for what amounts to four wildcard kinds. If a real BM25 lane lands later
 * this should swap to picomatch for parity.
 */
export function matchesAnyGlob(filePath: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return true;
  // Normalize to forward slashes; SQLite stores POSIX paths regardless of
  // host OS, so the comparison side is already POSIX.
  const normalized = filePath.split(path.sep).join("/");
  for (const pattern of patterns) {
    if (matchGlob(normalized, pattern)) return true;
  }
  return false;
}

function matchGlob(filePath: string, pattern: string): boolean {
  // Translate the glob to a RegExp. Order matters: handle `**` before `*`.
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern.charAt(i);
    if (c === "*" && pattern.charAt(i + 1) === "*") {
      // ** matches across path separators
      re += ".*";
      i += 2;
      // Skip an immediately following `/` so `src/**/foo` matches `src/foo`.
      if (pattern.charAt(i) === "/") i++;
    } else if (c === "*") {
      re += "[^/]*";
      i++;
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      re += "\\" + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  return new RegExp(`^${re}$`).test(filePath);
}

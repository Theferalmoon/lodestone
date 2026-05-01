// SPDX-License-Identifier: Apache-2.0
// LodestoneToolResponse<T> — universal MCP tool return envelope (post-Codex-001 shape).
import { z } from "zod";

/**
 * Provenance carries the full git + index state at the moment a tool produced
 * its results. Edge cases (detached HEAD, no upstream, fresh clone, non-git
 * directory) all have explicit field values — see the per-field docs.
 *
 * Sentinel values:
 * - `staleness_seconds === -1` ⇔ never indexed (used together with `indexed_at: null`).
 *   Any other negative value is invalid; the runtime schema below enforces this.
 */
export interface Provenance {
  /** True if the project is a git repository. False for tests / non-git dirs. */
  is_git_repo: boolean;
  /** Short hash of HEAD at request time. `null` when `is_git_repo === false`. */
  head_commit: string | null;
  /** Short hash of HEAD at the moment the index was last written. `null` when never indexed or not a git repo. */
  indexed_commit: string | null;
  /** True if the working tree had uncommitted changes when the index was written. */
  dirty_at_index: boolean;
  /** True if the working tree currently has uncommitted changes (re-checked at request time). */
  dirty_now: boolean;
  /** Number of commits between `indexed_commit` and `head_commit`. >= 0. */
  commits_since_index: number;
  /** True if HEAD has an upstream branch configured. */
  has_upstream: boolean;
  /** Upstream branch name (e.g. "origin/main"). `null` when `has_upstream === false`. */
  upstream_branch: string | null;
  /** Number of commits HEAD is behind upstream. >= 0; `0` when `has_upstream === false`. */
  commits_behind_upstream: number;
  /** ISO-8601 timestamp of last successful index write. `null` if never indexed. */
  indexed_at: string | null;
  /** Seconds since `indexed_at`. >= 0 normally; `-1` is the documented sentinel for "never indexed". */
  staleness_seconds: number;
  /** Monotonic counter bumped on every successful ingest. Used for cross-store consistency. */
  index_epoch: number;
  /**
   * - `"live"`: ingest worker is caught up
   * - `"stale"`: index is older than the watcher debounce window
   * - `"not_ready"`: ready.json missing or `ready: false`
   */
  source: "live" | "stale" | "not_ready";
}

/**
 * Runtime validator for Provenance. Enforces the non-negative invariants the
 * spec called out (commits_since_index, commits_behind_upstream, index_epoch all >= 0;
 * staleness_seconds >= 0 OR === -1 sentinel). MCP server uses this to validate
 * envelopes constructed inside tool handlers.
 */
export const provenanceSchema = z
  .object({
    is_git_repo: z.boolean(),
    head_commit: z.string().nullable(),
    indexed_commit: z.string().nullable(),
    dirty_at_index: z.boolean(),
    dirty_now: z.boolean(),
    commits_since_index: z.number().int().nonnegative(),
    has_upstream: z.boolean(),
    upstream_branch: z.string().nullable(),
    commits_behind_upstream: z.number().int().nonnegative(),
    indexed_at: z.string().nullable(),
    staleness_seconds: z.number().int(),
    index_epoch: z.number().int().nonnegative(),
    source: z.enum(["live", "stale", "not_ready"]),
  })
  .refine((v) => v.staleness_seconds >= 0 || v.staleness_seconds === -1, {
    message: "staleness_seconds must be >= 0 or exactly -1 (never-indexed sentinel)",
    path: ["staleness_seconds"],
  });

/** Validates a Provenance candidate. Throws ZodError on invalid shape. */
export function parseProvenance(raw: unknown): Provenance {
  return provenanceSchema.parse(raw) as Provenance;
}

export interface Diagnostics {
  /** 0..1, files-indexed / non-ignored-files-in-repo. */
  coverage: number;
  /** Explicit definition of what `coverage` measures. */
  coverage_basis: "files-indexed-vs-non-ignored";
  /** Human-readable warnings (stale index, partial degradation, etc.). */
  warnings?: string[];
  /** Set true when the response was truncated to fit `max_response_kb`. */
  truncated?: boolean;
  /** Set true when an input parameter (e.g. `top_k`) was silently clamped to its cap. */
  clamped?: boolean;
}

/**
 * The universal envelope every MCP tool returns. `request_id` is REQUIRED (UUID v7,
 * server-generated) so the `feedback` tool can reference prior calls. `results` is
 * the per-tool payload (typed by `T`).
 */
export interface LodestoneToolResponse<T> {
  /** UUID v7 (monotonic), server-generated. Used by feedback() to reference this call. */
  request_id: string;
  results: T[];
  provenance: Provenance;
  diagnostics: Diagnostics;
}

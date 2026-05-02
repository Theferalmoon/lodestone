// SPDX-License-Identifier: Apache-2.0
// Thin git helpers for section 14 search tools.
//
// All shell-out goes through `execFileSync` with arg arrays — never through a
// shell — so user-supplied `since`/`paths` cannot inject. Failures are
// reported by returning `null` (for resolveCommitTimestamp) or by throwing a
// typed `GitUnavailableError` (for the log walker), which the caller turns
// into a degraded envelope.
//
// This module is intentionally Lodestone-aware: it expects the caller to have
// already classified `since` via `parseSince` from `./since.ts` and converted
// commit-hash inputs to a wall-clock timestamp via `resolveCommitTimestamp`.
// The walker just takes a cwd + optional cutoff timestamp + path filter and
// emits structured commits.

import { execFileSync } from "node:child_process";

export class GitUnavailableError extends Error {
  constructor(reason: string) {
    super(`git not available or not a repository: ${reason}`);
    this.name = "GitUnavailableError";
  }
}

/** A single git commit with the files it touched, lite enough to carry over
 * the wire as part of a `recent_changes` bucket. */
export interface CommitRecord {
  hash: string;
  /** Subject line (first line of commit message). */
  subject: string;
  /** Author name as recorded by git. */
  author: string;
  /** Commit timestamp in unix epoch milliseconds. */
  timestamp_ms: number;
  /** POSIX file paths touched by the commit (relative to repo root). */
  files: string[];
}

/** Run a `git` invocation against `cwd` and return stdout, or throw
 * `GitUnavailableError`. Exposed as a single helper so every call inherits the
 * same args-array safety + suppressed stderr. */
function runGit(cwd: string, args: readonly string[]): string {
  try {
    return execFileSync("git", args as string[], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      // 5 MB cap is generous for `git log` against a normal repo. Anything
      // larger is a runaway query and should fail rather than balloon RAM.
      maxBuffer: 5 * 1024 * 1024,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new GitUnavailableError(msg);
  }
}

/** Resolve a commit hash (full or short) to its committer timestamp in epoch
 * milliseconds. Returns `null` when the hash is not found in the repo so the
 * caller can degrade gracefully. */
export function resolveCommitTimestamp(cwd: string, hash: string): number | null {
  try {
    const out = runGit(cwd, ["log", "-1", "--format=%ct", hash]);
    const trimmed = out.trim();
    if (!trimmed) return null;
    const sec = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(sec)) return null;
    return sec * 1000;
  } catch {
    return null;
  }
}

/** True if `cwd` looks like a git repository. Cheap: one `git rev-parse`. */
export function isGitRepo(cwd: string): boolean {
  try {
    const out = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
    return out.trim() === "true";
  } catch {
    return false;
  }
}

/** Options for `walkLog`. */
export interface WalkLogOptions {
  /** Repo root or any subdir. */
  cwd: string;
  /** Optional cutoff. Only commits at-or-after this epoch-ms are returned. */
  sinceEpochMs?: number;
  /** Optional path filters. Each is passed as a `--` pathspec to git. */
  paths?: readonly string[];
  /** Hard cap on commits returned. Defaults to 200. */
  maxCommits?: number;
}

/** A delimiter that cannot legitimately appear in a commit subject or author
 * (NUL byte). Used to safely separate the format fields. */
const FIELD_SEP = "\x1f"; // unit separator
const RECORD_SEP = "\x1e"; // record separator

/**
 * Walk `git log` and emit structured `CommitRecord`s newest-first. Streams
 * file paths via `--name-only` and parses with explicit delimiters so commit
 * subjects can contain any character (newlines, pipes, etc.) without
 * breaking the parser.
 */
export function walkLog(opts: WalkLogOptions): CommitRecord[] {
  const { cwd, sinceEpochMs, paths, maxCommits = 200 } = opts;
  const args: string[] = ["log", "--no-merges", "--name-only"];
  // %x1e between commits, %x1f between fields. We do NOT include the file
  // list in the format string — git appends it after the formatted line via
  // --name-only, separated from the next commit by a blank line.
  args.push(`--format=${RECORD_SEP}%H${FIELD_SEP}%ct${FIELD_SEP}%an${FIELD_SEP}%s`);
  if (typeof sinceEpochMs === "number") {
    // git accepts ISO 8601 here. Convert from ms.
    const iso = new Date(sinceEpochMs).toISOString();
    args.push(`--since=${iso}`);
  }
  args.push(`-n`, String(maxCommits));
  // Path filters are pathspec; the `--` separator marks the end of opts.
  if (paths && paths.length > 0) {
    args.push("--");
    for (const p of paths) args.push(p);
  }

  const stdout = runGit(cwd, args);
  if (!stdout.trim()) return [];

  const records: CommitRecord[] = [];
  // Split on RECORD_SEP. The first chunk is empty (output starts with the sep).
  const chunks = stdout.split(RECORD_SEP);
  for (const chunk of chunks) {
    if (!chunk) continue;
    // First line is the formatted header; remaining nonblank lines are files.
    const lines = chunk.split("\n");
    const header = lines[0] ?? "";
    const fields = header.split(FIELD_SEP);
    if (fields.length < 4) continue;
    const hash = (fields[0] ?? "").trim();
    const ctSec = Number.parseInt((fields[1] ?? "").trim(), 10);
    const author = (fields[2] ?? "").trim();
    const subject = (fields[3] ?? "").trim();
    if (!hash || !Number.isFinite(ctSec)) continue;
    const files: string[] = [];
    for (let i = 1; i < lines.length; i++) {
      const file = (lines[i] ?? "").trim();
      if (file.length > 0) files.push(file);
    }
    records.push({
      hash,
      subject,
      author,
      timestamp_ms: ctSec * 1000,
      files,
    });
  }
  return records;
}

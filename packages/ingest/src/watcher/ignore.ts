// SPDX-License-Identifier: Apache-2.0
// Ignore matcher: built-in noisy-dir list + optional .gitignore inheritance +
// caller-supplied extra patterns. Returns a single function suitable for
// chokidar's `ignored` option.

import { readFileSync } from "node:fs";
import path from "node:path";

// `ignore` ships as CJS with a namespaced default export; under NodeNext
// the `default` is the namespace and the call signature lives on a runtime
// property. We grab it via interop and silence the no-explicit-any check.
import ignoreModule from "ignore";
import type { Ignore } from "ignore";

type IgnoreFactory = (options?: { ignorecase?: boolean; ignoreCase?: boolean; allowRelativePaths?: boolean }) => Ignore;
const ignoreFactory: IgnoreFactory =
  (ignoreModule as unknown as IgnoreFactory & { default?: IgnoreFactory }).default ??
  (ignoreModule as unknown as IgnoreFactory);

/**
 * Hard-coded ignore list applied unconditionally. These directories are
 * never useful to re-ingest and `.lodestone/` MUST be present here to
 * prevent the watcher → ingest → write → watcher self-feedback loop.
 */
export const BUILTIN_IGNORE_PATTERNS: readonly string[] = Object.freeze([
  "node_modules",
  "node_modules/**",
  ".git",
  ".git/**",
  "dist",
  "dist/**",
  "build",
  "build/**",
  "__pycache__",
  "__pycache__/**",
  ".venv",
  ".venv/**",
  ".cache",
  ".cache/**",
  "target",
  "target/**",
  ".next",
  ".next/**",
  ".lodestone",
  ".lodestone/**",
  "coverage",
  "coverage/**",
  ".turbo",
  ".turbo/**",
]);

/**
 * Codex impl-012 RED — hard, NON-NEGOTIABLE excludes. These directory
 * segments are checked by raw path-segment scan BEFORE the negatable
 * `ignore` matcher runs. A repo `.gitignore` like `!.lodestone/**` (or
 * `extra: ["!.lodestone"]`) cannot re-allow them. `.lodestone` is the
 * runtime dir and a self-watch loop here means the watcher fires every
 * time ingest writes — we never let operator config override that.
 *
 * `.git` and `node_modules` are also hard-locked: re-watching them is
 * never useful and always expensive.
 */
export const HARD_EXCLUDE_SEGMENTS: readonly string[] = Object.freeze([
  ".lodestone",
  ".git",
  "node_modules",
]);

/**
 * Returns true when any path segment matches a HARD_EXCLUDE_SEGMENTS
 * entry. POSIX-separated, repo-relative input expected.
 */
export function isHardExcluded(relPath: string): boolean {
  if (relPath === "" || relPath === ".") return false;
  const segs = relPath.split("/");
  for (const s of segs) {
    if (s === "") continue;
    for (const hard of HARD_EXCLUDE_SEGMENTS) {
      if (s === hard) return true;
    }
  }
  return false;
}

export interface IgnoreMatcher {
  /** True when `relPath` (POSIX-separated, repo-relative) should be ignored. */
  ignores(relPath: string): boolean;
  /** Underlying `ignore` instance (test introspection). */
  raw(): Ignore;
}

export interface BuildIgnoreOptions {
  cwd: string;
  inheritGitignore: boolean;
  extra: readonly string[];
  /** Override the gitignore reader (test seam). */
  readGitignore?: (cwd: string) => string | null;
}

function defaultReadGitignore(cwd: string): string | null {
  try {
    return readFileSync(path.join(cwd, ".gitignore"), "utf8");
  } catch {
    return null;
  }
}

/**
 * Build the merged ignore matcher. Order is: builtins first, then
 * `.gitignore` (if enabled and present), then `extra`. Later patterns can
 * negate earlier ones via the `!` prefix per gitignore semantics.
 */
export function buildIgnoreMatcher(opts: BuildIgnoreOptions): IgnoreMatcher {
  const ig: Ignore = ignoreFactory({ allowRelativePaths: true });
  ig.add([...BUILTIN_IGNORE_PATTERNS]);

  if (opts.inheritGitignore) {
    const reader = opts.readGitignore ?? defaultReadGitignore;
    const body = reader(opts.cwd);
    if (body && body.trim().length > 0) {
      ig.add(body);
    }
  }

  if (opts.extra.length > 0) {
    ig.add([...opts.extra]);
  }

  return {
    ignores(relPath: string): boolean {
      if (relPath === "" || relPath === ".") return false;
      // `ignore` requires forward-slash repo-relative paths and rejects
      // a leading "./". Normalise once here.
      let normalized = relPath.replace(/\\/g, "/");
      if (normalized.startsWith("./")) normalized = normalized.slice(2);
      if (normalized === "") return false;
      // Hard guard FIRST. `.lodestone/`, `.git/`, `node_modules/` cannot
      // be unignored by operator `.gitignore` negation patterns or by
      // caller-supplied `extra` patterns. See HARD_EXCLUDE_SEGMENTS.
      if (isHardExcluded(normalized)) return true;
      return ig.ignores(normalized);
    },
    raw() {
      return ig;
    },
  };
}

/**
 * Convert an absolute path to a repo-relative POSIX path. Returns `""` when
 * `abs` is the cwd itself or when `abs` is outside `cwd` (the latter is
 * defensive — chokidar should never feed us such a path).
 */
export function toRelPosix(cwd: string, abs: string): string {
  if (abs === cwd) return "";
  const rel = path.relative(cwd, abs);
  if (rel === "" || rel.startsWith("..")) return "";
  return rel.split(path.sep).join("/");
}

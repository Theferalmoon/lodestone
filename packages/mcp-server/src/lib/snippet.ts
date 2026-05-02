// SPDX-License-Identifier: Apache-2.0
// Source-window snippet builder for section 14 `query`. The §14 brief calls
// for ~20 source lines centered on the symbol; the prior implementation
// returned only metadata (signature + docstring) which left agents without
// the actual code context. This module reads the file from disk, slices the
// requested window, and falls back gracefully when the file is missing.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface SnippetWindow {
  /** Path used (resolved against `repoRoot`). */
  path: string;
  /** Inclusive 1-based start line of the returned window. */
  start_line: number;
  /** Inclusive 1-based end line of the returned window. */
  end_line: number;
  /** Joined source lines (no trailing newline). */
  text: string;
  /** True when the window was synthesized from row metadata, not file source. */
  fallback: boolean;
}

export interface BuildSnippetOptions {
  repoRoot: string;
  /** Repo-relative POSIX path stored in the symbols table. */
  filePath: string;
  startLine: number;
  endLine: number;
  /** Lines of context on each side of the symbol body. Default 5. */
  context?: number;
  /** Hard cap on lines returned. Default 40 (so a 30-line symbol with default
   * context still fits within a sensible response budget). */
  maxLines?: number;
  /** Optional fallback text (signature/docstring) used when the file is
   * unreadable. The shape of the returned object is identical so callers do
   * not branch on success vs fallback. */
  fallbackText: string;
}

/**
 * Build a source-line window. Reads the file once, slices to
 * `[startLine - context, endLine + context]` (1-based, clamped to file
 * bounds), and returns the joined text. Fallback text is used when the file
 * is missing, unreadable, or empty after slicing.
 */
export function buildSnippetWindow(opts: BuildSnippetOptions): SnippetWindow {
  const ctx = opts.context ?? 5;
  const maxLines = opts.maxLines ?? 40;
  const abs = path.isAbsolute(opts.filePath)
    ? opts.filePath
    : path.join(opts.repoRoot, opts.filePath);

  if (!existsSync(abs)) {
    return {
      path: opts.filePath,
      start_line: opts.startLine,
      end_line: opts.endLine,
      text: opts.fallbackText,
      fallback: true,
    };
  }
  let raw: string;
  try {
    raw = readFileSync(abs, "utf8");
  } catch {
    return {
      path: opts.filePath,
      start_line: opts.startLine,
      end_line: opts.endLine,
      text: opts.fallbackText,
      fallback: true,
    };
  }
  const lines = raw.split(/\r?\n/);
  if (lines.length === 0) {
    return {
      path: opts.filePath,
      start_line: opts.startLine,
      end_line: opts.endLine,
      text: opts.fallbackText,
      fallback: true,
    };
  }
  // Clamp the window. Symbols table is 1-indexed.
  const total = lines.length;
  const startWanted = Math.max(1, opts.startLine - ctx);
  const endWanted = Math.min(total, opts.endLine + ctx);
  // Apply maxLines cap. Prefer to keep the window centered on the symbol, so
  // shrink symmetrically when over budget.
  let actualStart = startWanted;
  let actualEnd = endWanted;
  if (actualEnd - actualStart + 1 > maxLines) {
    const excess = actualEnd - actualStart + 1 - maxLines;
    const trimEachSide = Math.floor(excess / 2);
    actualStart = Math.min(opts.startLine, actualStart + trimEachSide);
    actualEnd = Math.max(opts.endLine, actualEnd - (excess - trimEachSide));
    // Ensure we still fit.
    if (actualEnd - actualStart + 1 > maxLines) {
      actualEnd = actualStart + maxLines - 1;
    }
  }
  // Slice is 0-indexed, end-exclusive.
  const slice = lines.slice(actualStart - 1, actualEnd);
  if (slice.length === 0) {
    return {
      path: opts.filePath,
      start_line: opts.startLine,
      end_line: opts.endLine,
      text: opts.fallbackText,
      fallback: true,
    };
  }
  return {
    path: opts.filePath,
    start_line: actualStart,
    end_line: actualStart + slice.length - 1,
    text: slice.join("\n"),
    fallback: false,
  };
}

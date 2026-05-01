// SPDX-License-Identifier: Apache-2.0
// Opt-in CLAUDE.md augmentation. Default install path is `snippet.ts` (print
// to stdout, no file modification). Idempotency is keyed on marker presence
// so friends can hand-edit the contents between markers without losing their
// changes on re-install.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomic.js";
import { getClaudeMdSnippet } from "./snippet.js";

export interface AugmentClaudeMdOptions {
  /** False = no-op (caller should use snippet.printClaudeMdSnippet() instead). */
  write: boolean;
  repoRoot: string;
}

export interface AugmentClaudeMdResult {
  action: "created" | "appended" | "already_present" | "skipped";
  path?: string;
}

export const BEGIN_MARKER = "<!-- BEGIN LODESTONE -->";
export const END_MARKER = "<!-- END LODESTONE -->";

/**
 * Friend-facing CLAUDE.md augment.
 *
 * - `write: false` ⇒ `{ action: "skipped" }` and no filesystem touch. Caller
 *   should use `snippet.printClaudeMdSnippet()` for the default path.
 * - `write: true`:
 *   - File absent → create with the marker-bracketed snippet (`created`).
 *   - File exists, no markers → append the marker-bracketed stanza (`appended`).
 *   - File exists, markers present → no-op (`already_present`), even when
 *     the friend hand-edited content between the markers. We do not rewrite,
 *     so their edits survive every re-run.
 */
export function augmentClaudeMd(opts: AugmentClaudeMdOptions): AugmentClaudeMdResult {
  if (!opts.write) {
    return { action: "skipped" };
  }

  const claudeMdPath = path.join(opts.repoRoot, "CLAUDE.md");
  const stanza = `${BEGIN_MARKER}\n\n${getClaudeMdSnippet()}\n${END_MARKER}\n`;

  if (!existsSync(claudeMdPath)) {
    writeFileAtomic(claudeMdPath, stanza);
    return { action: "created", path: claudeMdPath };
  }

  const body = readFileSync(claudeMdPath, "utf8");
  if (body.includes(BEGIN_MARKER) && body.includes(END_MARKER)) {
    return { action: "already_present", path: claudeMdPath };
  }

  // Append: ensure separation from prior content. Single trailing newline on
  // the prior content is enough — tests cover both "ends with newline" and
  // "no trailing newline" cases via the empty-init creation path.
  const sep = body.endsWith("\n") ? "\n" : "\n\n";
  writeFileAtomic(claudeMdPath, `${body}${sep}${stanza}`);
  return { action: "appended", path: claudeMdPath };
}

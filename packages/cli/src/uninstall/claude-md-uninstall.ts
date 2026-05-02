// SPDX-License-Identifier: Apache-2.0
// Inverse of `install/claude-md.ts`. Removes the `<!-- BEGIN LODESTONE -->` …
// `<!-- END LODESTONE -->` block from the friend's CLAUDE.md.
//
// Provenance respect (load-bearing): if the install manifest records the
// CLAUDE.md action as `already_present` (markers were authored by the friend
// before init ran) or `skipped` (init opted out of CLAUDE.md entirely),
// uninstall does NOT touch the file. Only `created` (init wrote the file
// fresh — uninstall deletes it) and `appended` (init added the block to a
// pre-existing file — uninstall excises just that block) are reversed.
//
// TRAILING-NEWLINE POLICY (Codex §19 YELLOW, documented):
//   When uninstall removes the appended block from a pre-existing
//   CLAUDE.md, it normalizes the restored file to end with a single
//   trailing newline. Reason: the install pass irreversibly drops the
//   information needed to know whether the friend's pre-install body
//   ended with `\n`. Most editors (vim, VS Code, Emacs, etc.) and POSIX
//   text-file conventions ensure `\n` termination, so this is the
//   friend-favoring default. Visible consequence: a CLAUDE.md that was
//   deliberately authored without a trailing newline will gain one on
//   uninstall. Byte-identity to the pre-install state is NOT a guarantee
//   in this case — see PRIVACY.md for the full statement.
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../install/atomic.js";
import { BEGIN_MARKER, END_MARKER } from "../install/claude-md.js";
import type { AugmentClaudeMdResult } from "../install/claude-md.js";

export interface RemoveClaudeMdResult {
  /**
   * - `removed-block`: marker-bracketed stanza excised from existing file.
   * - `removed-file`: file existed only because init created it; deleted.
   * - `noop`: nothing to undo (file absent, markers absent, or init never
   *   touched CLAUDE.md per manifest).
   * - `respected-provenance`: manifest says init did not author the block
   *   (`already_present`/`skipped`); file deliberately untouched.
   * - `unreadable`: file exists but could not be read; left alone.
   */
  action:
    | "removed-block"
    | "removed-file"
    | "noop"
    | "respected-provenance"
    | "unreadable";
  path: string;
  detail?: string;
}

/**
 * Remove the lodestone-authored stanza from CLAUDE.md per the manifest's
 * provenance record.
 *
 * @param manifestClaudeMd  the `claude_md` field from the install manifest.
 *                          When `null`, callers are in conservative mode —
 *                          we do nothing (return `noop`).
 */
export function removeClaudeMdBlock(
  repoRoot: string,
  manifestClaudeMd: AugmentClaudeMdResult | null,
  opts: { dryRun?: boolean } = {}
): RemoveClaudeMdResult {
  const claudeMdPath = path.join(repoRoot, "CLAUDE.md");

  // Conservative mode (no manifest) — never touch CLAUDE.md.
  if (manifestClaudeMd === null) {
    return { action: "noop", path: claudeMdPath };
  }

  // Init never authored a block — friend's pre-existing markers (if any)
  // belong to them, or init was run without --write-claude-md.
  if (
    manifestClaudeMd.action === "already_present" ||
    manifestClaudeMd.action === "skipped"
  ) {
    return { action: "respected-provenance", path: claudeMdPath };
  }

  if (!existsSync(claudeMdPath)) {
    return { action: "noop", path: claudeMdPath };
  }

  // `created`: init wrote the whole file. Restore pre-init state by deleting it.
  if (manifestClaudeMd.action === "created") {
    if (opts.dryRun === true) {
      return { action: "removed-file", path: claudeMdPath };
    }
    try {
      unlinkSync(claudeMdPath);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { action: "unreadable", path: claudeMdPath, detail };
    }
    return { action: "removed-file", path: claudeMdPath };
  }

  // `appended`: init added the block to a pre-existing file. Excise just the
  // block, including the separator newlines init emitted.
  let body: string;
  try {
    body = readFileSync(claudeMdPath, "utf8");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { action: "unreadable", path: claudeMdPath, detail };
  }

  const beginIdx = body.indexOf(BEGIN_MARKER);
  const endIdx = body.indexOf(END_MARKER);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
    // Friend hand-deleted the block already. Nothing to do.
    return { action: "noop", path: claudeMdPath };
  }

  // Excise [beginIdx, endIdx + END_MARKER.length + 1) including the trailing
  // newline init wrote after END_MARKER, plus the leading separator init
  // inserted before BEGIN_MARKER.
  //
  // Init emitted: `${body}${sep}${BEGIN}\n\n${snippet}\n${END}\n` where
  //   sep = "\n"   if body ended with "\n"   → 2 nls precede BEGIN; strip 1
  //                                            (the separator). Friend's
  //                                            trailing nl stays.
  //   sep = "\n\n" if body did not            → 2 nls precede BEGIN; strip 2
  //                                            (both separator). No friend
  //                                            trailing nl to preserve.
  //
  // The information needed to distinguish cases (whether the friend's body
  // ended with "\n") is no longer available post-install — the file just
  // shows two consecutive newlines before BEGIN. We choose the friend-favoring
  // policy: assume the friend wants a trailing newline on their CLAUDE.md
  // (true for ~every editor's auto-trim convention; POSIX text-file rule).
  //
  //  Strategy: drop the trailing "\n" after END, drop ALL adjacent "\n"
  //  immediately before BEGIN (the separator + any friend trailing nls), then
  //  re-add a single "\n" if the result is non-empty. Result:
  //   Case A (body="…content\n"):  "…content\n"  ✓ byte-identical
  //   Case B (body="…content"):    "…content\n"  acceptable (gains POSIX nl)
  //   Case C (body=""):            ""            → caller deletes empty file
  let cutStart = beginIdx;
  let cutEnd = endIdx + END_MARKER.length;
  if (body[cutEnd] === "\n") cutEnd += 1;
  while (cutStart > 0 && body[cutStart - 1] === "\n") cutStart -= 1;

  let restored = body.slice(0, cutStart) + body.slice(cutEnd);
  if (restored.length > 0 && !restored.endsWith("\n")) {
    restored += "\n";
  }

  if (opts.dryRun === true) {
    return { action: "removed-block", path: claudeMdPath };
  }

  if (restored.length === 0) {
    // Edge case: friend's CLAUDE.md contained ONLY the lodestone block (init
    // logged action=appended on a zero-length file). Delete the now-empty file
    // for byte-identity with the original empty state.
    try {
      unlinkSync(claudeMdPath);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { action: "unreadable", path: claudeMdPath, detail };
    }
    return { action: "removed-file", path: claudeMdPath };
  }

  writeFileAtomic(claudeMdPath, restored);
  return { action: "removed-block", path: claudeMdPath };
}

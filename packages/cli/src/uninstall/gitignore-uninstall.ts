// SPDX-License-Identifier: Apache-2.0
// Inverse of `install/gitignore.ts`. Removes the `.lodestone/` line from
// `<repoRoot>/.gitignore` IFF the install manifest records that init authored
// it (action `created` or `appended`). A pre-existing line (`noop`) is left
// alone — it belongs to the friend.
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../install/atomic.js";
import type { UpdateGitignoreResult } from "../install/gitignore.js";

export interface RemoveGitignoreResult {
  /**
   * - `removed-line`: line was present and is now gone.
   * - `removed-file`: file existed only because init created it; deleted.
   * - `noop`: nothing to undo (line absent, or file absent).
   * - `respected-provenance`: manifest says init did not author the line
   *   (`noop`); deliberately untouched.
   * - `unreadable`: file exists but could not be read; left alone.
   */
  action:
    | "removed-line"
    | "removed-file"
    | "noop"
    | "respected-provenance"
    | "unreadable";
  path: string;
  detail?: string;
}

const TARGET_LINE = ".lodestone/";

/**
 * Remove the lodestone-authored `.lodestone/` line from `.gitignore` per the
 * install manifest's provenance.
 *
 * @param manifestGitignore  the `gitignore` field from the install manifest.
 *                           When `null`, callers are in conservative mode —
 *                           we do nothing (return `noop`).
 *
 * Match is newline-anchored exact (CRLF-tolerant): only a stand-alone
 * `.lodestone/` line is removed. `# .lodestone/` (a comment) and
 * `lodestone/` (no leading dot) are NOT touched.
 */
export function removeGitignoreLine(
  repoRoot: string,
  manifestGitignore: UpdateGitignoreResult | null,
  opts: { dryRun?: boolean } = {}
): RemoveGitignoreResult {
  const gitignorePath = path.join(repoRoot, ".gitignore");

  if (manifestGitignore === null) {
    return { action: "noop", path: gitignorePath };
  }
  if (manifestGitignore.action === "noop") {
    // Friend already had the line before init ran. Hands off.
    return { action: "respected-provenance", path: gitignorePath };
  }

  if (!existsSync(gitignorePath)) {
    return { action: "noop", path: gitignorePath };
  }

  // `created`: init wrote the file fresh. Restore pre-init state by deleting it.
  if (manifestGitignore.action === "created") {
    if (opts.dryRun === true) {
      return { action: "removed-file", path: gitignorePath };
    }
    try {
      unlinkSync(gitignorePath);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { action: "unreadable", path: gitignorePath, detail };
    }
    return { action: "removed-file", path: gitignorePath };
  }

  // `appended`: file existed before init; init added the line. Excise it.
  let body: string;
  try {
    body = readFileSync(gitignorePath, "utf8");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { action: "unreadable", path: gitignorePath, detail };
  }

  // Split on "\n", strip CR for matching, but preserve original line shape on
  // the way back so a CRLF file stays CRLF.
  const segments = body.split("\n");
  const filtered: string[] = [];
  let removedAny = false;
  for (const seg of segments) {
    const cmp = seg.replace(/\r$/, "");
    if (!removedAny && cmp === TARGET_LINE) {
      removedAny = true;
      continue;
    }
    filtered.push(seg);
  }

  if (!removedAny) {
    // Friend hand-removed the line already; nothing to do.
    return { action: "noop", path: gitignorePath };
  }

  if (opts.dryRun === true) {
    return { action: "removed-line", path: gitignorePath };
  }

  let restored = filtered.join("\n");
  // Edge case: if removing the line emptied the file (only ".lodestone/\n"),
  // delete the file rather than leave an empty .gitignore. This keeps
  // byte-identity with "no .gitignore at all" only when init's `appended`
  // action started from a file that contained nothing but a trailing newline
  // — rare, but possible when a friend touched .gitignore without committing.
  if (restored === "\n" || restored === "") {
    try {
      unlinkSync(gitignorePath);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { action: "unreadable", path: gitignorePath, detail };
    }
    return { action: "removed-file", path: gitignorePath };
  }

  writeFileAtomic(gitignorePath, restored);
  return { action: "removed-line", path: gitignorePath };
}

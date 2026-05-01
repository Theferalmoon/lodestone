// SPDX-License-Identifier: Apache-2.0
// Idempotent .gitignore patcher for `.lodestone/`. Newline-anchored exact
// match so that `lodestone/` (no leading dot) and `# .lodestone/` (a comment)
// are NOT counted as hits. Caller (init.ts) records the action in the install
// manifest so `uninstall` (§19) knows whether init added the line.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomic.js";

export interface UpdateGitignoreResult {
  action: "created" | "appended" | "noop";
  path: string;
}

const TARGET_LINE = ".lodestone/";

/**
 * Ensures `.lodestone/` is present as a stand-alone line in
 * `<repoRoot>/.gitignore`.
 * - `created`: the file did not exist; we wrote it with just `.lodestone/\n`.
 * - `appended`: the file existed but did not contain the line; we appended
 *   it (with a leading newline if the existing file did not end in one).
 * - `noop`: the line is already present (anchored exact match).
 *
 * Match is `(^|\n).lodestone/(\n|$)` — equivalent to a newline-anchored
 * exact-line match. `lodestone/` (no leading dot) and a commented
 * `# .lodestone/` line are NOT hits. Globs are not expanded.
 */
export function updateGitignore(repoRoot: string): UpdateGitignoreResult {
  const gitignorePath = path.join(repoRoot, ".gitignore");

  if (!existsSync(gitignorePath)) {
    writeFileAtomic(gitignorePath, `${TARGET_LINE}\n`);
    return { action: "created", path: gitignorePath };
  }

  const body = readFileSync(gitignorePath, "utf8");
  if (containsExactLine(body, TARGET_LINE)) {
    return { action: "noop", path: gitignorePath };
  }

  // Ensure separator: existing body must end with a newline before the
  // appended line, and the appended line itself ends with a newline.
  const sep = body.endsWith("\n") ? "" : "\n";
  writeFileAtomic(gitignorePath, `${body}${sep}${TARGET_LINE}\n`);
  return { action: "appended", path: gitignorePath };
}

function containsExactLine(body: string, line: string): boolean {
  // Strip trailing \r so a CRLF-formatted .gitignore (common on Windows-WSL2
  // when the friend's editor writes Windows line endings) still matches.
  // Without this trim, a CRLF `.lodestone/\r\n` line is read as `.lodestone/\r`
  // and we'd append a duplicate Unix `.lodestone/\n` on every run, breaking
  // the byte-identical idempotency guarantee.
  for (const candidate of body.split("\n")) {
    if (candidate.replace(/\r$/, "") === line) return true;
  }
  return false;
}

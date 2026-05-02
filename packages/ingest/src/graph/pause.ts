// SPDX-License-Identifier: Apache-2.0
// Pause-on-git-operation gate. The watcher (§12) and storage layer (§08)
// poll this to defer writes while a git operation holds `.git/index.lock`.
// Single-shot check; no retry, no debounce — caller polls.

import { access } from "node:fs/promises";
import path from "node:path";

/**
 * Returns `true` when `.git/index.lock` exists under `repoRoot`, signalling
 * that a git operation (commit, rebase, merge) is in progress and ingest
 * writes should defer.
 *
 * Returns `false` (do not pause) when:
 *   - `.git` itself is absent (test fixtures, non-repo dirs).
 *   - The lock file is absent.
 *   - `repoRoot` doesn't exist (treated as "no git, nothing to gate on").
 */
export async function shouldPause(repoRoot: string): Promise<boolean> {
  const gitDir = path.join(repoRoot, ".git");
  try {
    await access(gitDir);
  } catch {
    return false;
  }

  const lock = path.join(gitDir, "index.lock");
  try {
    await access(lock);
    return true;
  } catch {
    return false;
  }
}

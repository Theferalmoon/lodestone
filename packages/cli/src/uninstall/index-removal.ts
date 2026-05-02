// SPDX-License-Identifier: Apache-2.0
// Removes the `<repoRoot>/.lodestone/` tree itself — SQLite db, model cache,
// install manifest, runtime/, skills/, all of it. The whole-tree wipe is the
// final uninstall step (after manifest read + .mcp.json/CLAUDE.md/.gitignore
// reversals) because everything before it depends on the manifest sitting
// inside the tree.
//
// Safety: we resolve the tree path through `canonicalLodestoneDir` and assert
// it lives under the resolved `repoRoot` before any rm. Never delete files
// outside the friend's `.lodestone/`.
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { canonicalLodestoneDir } from "@lodestone/shared";

export interface RemoveIndexResult {
  /**
   * - `removed`: the tree was present and is now gone.
   * - `noop`: no `.lodestone/` tree existed (or `--keep-index` told us to skip).
   * - `failed`: deletion attempted and threw (permission denied, etc.).
   */
  action: "removed" | "noop" | "failed";
  path: string;
  /** Bytes freed (rough — sum of file sizes, dir entries themselves are ~0). */
  bytesFreed: number;
  detail?: string;
}

/**
 * Recursively delete the `.lodestone/` tree.
 *
 * `dryRun: true` walks the tree to compute `bytesFreed` but does not delete.
 * `keepIndex: true` returns `noop` immediately — used by `--keep-index` so a
 *   friend can uninstall the agent integration but keep the local data.
 */
export async function removeLodestoneTree(
  repoRoot: string,
  opts: { dryRun?: boolean; keepIndex?: boolean } = {}
): Promise<RemoveIndexResult> {
  const treePath = canonicalLodestoneDir(repoRoot);

  if (opts.keepIndex === true) {
    return { action: "noop", path: treePath, bytesFreed: 0 };
  }

  // Safety assertion: the resolved tree must sit under the resolved repo root.
  // Without this, a hostile `repoRoot` like "/" or "" could escape the intended
  // scope. `canonicalLodestoneDir` already joins to `<cwd>/.lodestone`, but the
  // explicit check is a belt-and-braces guard for the destructive operation.
  const resolvedRoot = path.resolve(repoRoot);
  const resolvedTree = path.resolve(treePath);
  const expectedPrefix = `${resolvedRoot}${path.sep}`;
  if (!resolvedTree.startsWith(expectedPrefix)) {
    return {
      action: "failed",
      path: treePath,
      bytesFreed: 0,
      detail: `safety check: ${resolvedTree} not under ${resolvedRoot}`,
    };
  }

  if (!existsSync(treePath)) {
    return { action: "noop", path: treePath, bytesFreed: 0 };
  }

  const bytesFreed = computeTreeSize(treePath);

  if (opts.dryRun === true) {
    return { action: "removed", path: treePath, bytesFreed };
  }

  try {
    await rm(treePath, { recursive: true, force: true });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { action: "failed", path: treePath, bytesFreed: 0, detail };
  }
  return { action: "removed", path: treePath, bytesFreed };
}

/**
 * Sum file sizes under `dir`, ignoring directory entries. Symlinks are NOT
 * followed — we report the link size, not the target. Errors mid-walk return
 * the partial total rather than throwing (the caller's view of "freed" is
 * informational, not load-bearing).
 *
 * Codex §19 YELLOW: `statSync()` follows symlinks, so a `.lodestone -> /etc`
 * symlink would have caused dry-run to walk and size up the target tree
 * (and potentially error mid-walk on permission denials). Use `lstatSync()`
 * so a symbolic link is reported by its own metadata (small inode payload)
 * rather than what it points at. The actual deletion path uses
 * `fs.rm({ recursive: true, force: true })` which unlinks the top-level
 * symlink without following it.
 */
function computeTreeSize(dir: string): number {
  let total = 0;
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    let st;
    try {
      st = lstatSync(current);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      // Count the link itself, never traverse into the target.
      total += st.size;
      continue;
    }
    if (st.isDirectory()) {
      let entries: string[];
      try {
        entries = readdirSync(current);
      } catch {
        continue;
      }
      for (const entry of entries) {
        stack.push(path.join(current, entry));
      }
    } else if (st.isFile()) {
      total += st.size;
    }
  }
  return total;
}

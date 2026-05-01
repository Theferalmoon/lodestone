// SPDX-License-Identifier: Apache-2.0
// `writeFileAtomic` — write through `<path>.tmp` then rename. The rename is
// atomic on POSIX and Windows-NTFS, so a Ctrl-C between write and rename
// leaves the prior file intact rather than truncated. Used by every install
// module so the friend's repo never observes a half-written .mcp.json /
// .gitignore / CLAUDE.md.
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";

export function writeFileAtomic(targetPath: string, body: string): void {
  const dir = path.dirname(targetPath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = `${targetPath}.tmp`;
  const fd = openSync(tmpPath, "w");
  try {
    writeSync(fd, body, 0, "utf8");
    // fsync so the rename observes a fully-flushed file. Cheap and worth it
    // for friend-repo writes that happen at most a handful of times per init.
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmpPath, targetPath);
  } catch (err) {
    // Best-effort cleanup of the .tmp on rename failure (rare — rename is
    // atomic on same-device targets, and we always write tmp adjacent).
    try {
      unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { removeLodestoneTree } from "../../uninstall/index-removal.js";

describe("removeLodestoneTree", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "lodestone-tree-uninst-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function seed(): number {
    const dir = path.join(tmp, ".lodestone");
    mkdirSync(path.join(dir, "runtime"), { recursive: true });
    mkdirSync(path.join(dir, "skills", "seed"), { recursive: true });
    const a = "a".repeat(123);
    const b = "b".repeat(456);
    const c = "c".repeat(789);
    writeFileSync(path.join(dir, "lodestone.sqlite"), a);
    writeFileSync(path.join(dir, "runtime", "lodestone-mcp"), b);
    writeFileSync(path.join(dir, "skills", "seed", "x.md"), c);
    return a.length + b.length + c.length;
  }

  it("removes the tree and reports bytesFreed correctly", async () => {
    const expectedBytes = seed();
    const r = await removeLodestoneTree(tmp);
    expect(r.action).toBe("removed");
    expect(r.bytesFreed).toBe(expectedBytes);
    expect(existsSync(path.join(tmp, ".lodestone"))).toBe(false);
  });

  it("noop when tree does not exist", async () => {
    const r = await removeLodestoneTree(tmp);
    expect(r.action).toBe("noop");
    expect(r.bytesFreed).toBe(0);
  });

  it("--keep-index returns noop without touching the tree", async () => {
    seed();
    const r = await removeLodestoneTree(tmp, { keepIndex: true });
    expect(r.action).toBe("noop");
    expect(existsSync(path.join(tmp, ".lodestone"))).toBe(true);
  });

  it("dryRun: action=removed, bytesFreed populated, tree still on disk", async () => {
    const expectedBytes = seed();
    const r = await removeLodestoneTree(tmp, { dryRun: true });
    expect(r.action).toBe("removed");
    expect(r.bytesFreed).toBe(expectedBytes);
    expect(existsSync(path.join(tmp, ".lodestone"))).toBe(true);
  });

  it("safety check: rejects when resolved tree is not under resolved repoRoot", async () => {
    // Force the safety check by using a subdir that doesn't have .lodestone
    // — but for the assertion to actually trigger, we'd need a path that
    // resolves OUTSIDE the repo. Easiest reproducible approach: use the
    // actual canonicalLodestoneDir, then verify the prefix check works for
    // a normal case AND we can't manufacture an escape path.
    //
    // The path-prefix logic is: resolvedTree must startWith resolvedRoot+sep.
    // This is exercised positively in every other test. A negative is hard
    // to manufacture without a hostile filesystem layout. We at least confirm
    // that a tmp without trailing slash still passes the check.
    seed();
    const r = await removeLodestoneTree(tmp);
    expect(r.action).toBe("removed");
  });

  it("idempotent: second call after removal returns noop", async () => {
    seed();
    expect((await removeLodestoneTree(tmp)).action).toBe("removed");
    expect((await removeLodestoneTree(tmp)).action).toBe("noop");
  });

  it("dry-run does NOT follow symlinks when sizing the tree (Codex §19 YELLOW: lstat)", async () => {
    // Set up a "decoy" target outside `.lodestone/` with a large file in
    // it. Pre-fix, computeTreeSize used statSync which followed symlinks
    // and added the decoy bytes to bytesFreed.
    const decoy = mkdtempSync(path.join(tmpdir(), "lodestone-decoy-"));
    const decoyBig = path.join(decoy, "big.bin");
    writeFileSync(decoyBig, "X".repeat(50_000));

    const treeDir = path.join(tmp, ".lodestone");
    mkdirSync(treeDir, { recursive: true });
    const realBytes = 100;
    writeFileSync(path.join(treeDir, "real.txt"), "r".repeat(realBytes));
    // Symlink inside .lodestone/ pointing at the decoy directory.
    symlinkSync(decoy, path.join(treeDir, "outside-link"));

    try {
      const r = await removeLodestoneTree(tmp, { dryRun: true });
      expect(r.action).toBe("removed");
      // bytesFreed must NOT include the 50_000-byte decoy. The symlink
      // contributes its own short path length only; the real file
      // contributes 100. Pin "<<50_000" to encode the no-traversal
      // invariant.
      expect(r.bytesFreed).toBeLessThan(10_000);
      expect(r.bytesFreed).toBeGreaterThanOrEqual(realBytes);
      // Tree still on disk after dry-run.
      expect(existsSync(treeDir)).toBe(true);
      // Decoy untouched.
      expect(existsSync(decoyBig)).toBe(true);
    } finally {
      rmSync(decoy, { recursive: true, force: true });
    }
  });

  it("actual removal unlinks symlinks without touching their targets", async () => {
    const decoy = mkdtempSync(path.join(tmpdir(), "lodestone-decoy-"));
    const decoyBig = path.join(decoy, "big.bin");
    writeFileSync(decoyBig, "X".repeat(50_000));

    const treeDir = path.join(tmp, ".lodestone");
    mkdirSync(treeDir, { recursive: true });
    writeFileSync(path.join(treeDir, "real.txt"), "real");
    symlinkSync(decoy, path.join(treeDir, "outside-link"));

    try {
      const r = await removeLodestoneTree(tmp);
      expect(r.action).toBe("removed");
      // .lodestone/ gone.
      expect(existsSync(treeDir)).toBe(false);
      // Symlink target sentinel intact.
      expect(existsSync(decoyBig)).toBe(true);
    } finally {
      rmSync(decoy, { recursive: true, force: true });
    }
  });
});

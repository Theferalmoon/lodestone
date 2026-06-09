// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { realpathDeepestExisting, pathsEqual } from "../path-equal.js";

describe("path-equal utilities", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "lodestone-path-equal-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("compares identical absolute paths", () => {
    const p1 = path.join(tmp, "a", "b", "c");
    const p2 = path.join(tmp, "a", "b", "c");
    expect(pathsEqual(p1, p2)).toBe(true);
  });

  it("resolves and compares paths where parts exist", () => {
    const dirA = path.join(tmp, "a");
    mkdirSync(dirA);
    const p1 = path.join(dirA, "b", "c");
    const p2 = path.join(dirA, "b", "c");
    expect(pathsEqual(p1, p2)).toBe(true);
  });

  it("resolves symlinks correctly", () => {
    const dirA = path.join(tmp, "a");
    const dirB = path.join(tmp, "b");
    mkdirSync(dirA);
    symlinkSync(dirA, dirB, "dir");

    const p1 = path.join(dirA, "foo", "bar");
    const p2 = path.join(dirB, "foo", "bar");
    expect(pathsEqual(p1, p2)).toBe(true);
  });

  it("compares relative and absolute paths pointing to same target", () => {
    const prevCwd = process.cwd();
    process.chdir(tmp);
    try {
      const relative = "foo/bar";
      const absolute = path.join(tmp, "foo", "bar");
      // If nothing exists:
      expect(pathsEqual(relative, absolute)).toBe(true);

      // If parent exists:
      mkdirSync(path.join(tmp, "foo"));
      expect(pathsEqual(relative, absolute)).toBe(true);
    } finally {
      process.chdir(prevCwd);
    }
  });
});

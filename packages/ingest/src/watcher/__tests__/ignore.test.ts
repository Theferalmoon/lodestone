// SPDX-License-Identifier: Apache-2.0
// Unit tests for the ignore matcher: builtins, .gitignore inheritance,
// extras, and path normalisation.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BUILTIN_IGNORE_PATTERNS,
  buildIgnoreMatcher,
  toRelPosix,
} from "../ignore.js";

describe("buildIgnoreMatcher", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "lodestone-ignore-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("rejects builtin paths even with no .gitignore present", () => {
    const m = buildIgnoreMatcher({ cwd: tmp, inheritGitignore: false, extra: [] });
    expect(m.ignores("node_modules/foo.js")).toBe(true);
    expect(m.ignores(".git/HEAD")).toBe(true);
    expect(m.ignores("dist/main.js")).toBe(true);
    expect(m.ignores("build/x")).toBe(true);
    expect(m.ignores("__pycache__/x.pyc")).toBe(true);
    expect(m.ignores(".venv/lib/x")).toBe(true);
    expect(m.ignores(".cache/x")).toBe(true);
    expect(m.ignores("target/x")).toBe(true);
    expect(m.ignores(".next/x")).toBe(true);
    expect(m.ignores(".lodestone/db.sqlite")).toBe(true);
  });

  it("does not reject normal source paths", () => {
    const m = buildIgnoreMatcher({ cwd: tmp, inheritGitignore: false, extra: [] });
    expect(m.ignores("src/foo.ts")).toBe(false);
    expect(m.ignores("README.md")).toBe(false);
    expect(m.ignores("packages/x/src/y.ts")).toBe(false);
  });

  it("inherits .gitignore when enabled", async () => {
    await writeFile(path.join(tmp, ".gitignore"), "secret.txt\ntmp/\n");
    const m = buildIgnoreMatcher({ cwd: tmp, inheritGitignore: true, extra: [] });
    expect(m.ignores("secret.txt")).toBe(true);
    expect(m.ignores("tmp/foo")).toBe(true);
    expect(m.ignores("src/foo.ts")).toBe(false);
  });

  it("ignores missing .gitignore quietly", () => {
    const m = buildIgnoreMatcher({ cwd: tmp, inheritGitignore: true, extra: [] });
    expect(m.ignores("src/foo.ts")).toBe(false);
  });

  it("respects inheritGitignore=false even when present", async () => {
    await writeFile(path.join(tmp, ".gitignore"), "secret.txt\n");
    const m = buildIgnoreMatcher({ cwd: tmp, inheritGitignore: false, extra: [] });
    expect(m.ignores("secret.txt")).toBe(false);
  });

  it("applies caller-supplied extra patterns", () => {
    const m = buildIgnoreMatcher({
      cwd: tmp,
      inheritGitignore: false,
      extra: ["*.log", "private/"],
    });
    expect(m.ignores("foo.log")).toBe(true);
    expect(m.ignores("private/x")).toBe(true);
    expect(m.ignores("foo.ts")).toBe(false);
  });

  it("supports gitignore negation in extras", () => {
    const m = buildIgnoreMatcher({
      cwd: tmp,
      inheritGitignore: false,
      extra: ["*.log", "!keep.log"],
    });
    expect(m.ignores("foo.log")).toBe(true);
    expect(m.ignores("keep.log")).toBe(false);
  });

  it("normalises Windows-style separators", () => {
    const m = buildIgnoreMatcher({ cwd: tmp, inheritGitignore: false, extra: [] });
    expect(m.ignores("node_modules\\foo")).toBe(true);
  });

  it("ignores empty / cwd-self paths", () => {
    const m = buildIgnoreMatcher({ cwd: tmp, inheritGitignore: false, extra: [] });
    expect(m.ignores("")).toBe(false);
    expect(m.ignores(".")).toBe(false);
  });

  it("normalises a leading ./", () => {
    const m = buildIgnoreMatcher({ cwd: tmp, inheritGitignore: false, extra: [] });
    expect(m.ignores("./node_modules/foo")).toBe(true);
    expect(m.ignores("./src/foo.ts")).toBe(false);
  });

  it("uses an injected gitignore reader (test seam)", () => {
    const m = buildIgnoreMatcher({
      cwd: tmp,
      inheritGitignore: true,
      extra: [],
      readGitignore: () => "*.bak\n",
    });
    expect(m.ignores("x.bak")).toBe(true);
  });

  it("treats blank gitignore content as no-op", () => {
    const m = buildIgnoreMatcher({
      cwd: tmp,
      inheritGitignore: true,
      extra: [],
      readGitignore: () => "   \n  \n",
    });
    expect(m.ignores("src/foo.ts")).toBe(false);
  });

  it("exposes the underlying ignore instance", () => {
    const m = buildIgnoreMatcher({ cwd: tmp, inheritGitignore: false, extra: [] });
    expect(typeof m.raw().ignores).toBe("function");
  });

  it("BUILTIN_IGNORE_PATTERNS is frozen and contains .lodestone", () => {
    expect(Object.isFrozen(BUILTIN_IGNORE_PATTERNS)).toBe(true);
    expect(BUILTIN_IGNORE_PATTERNS).toContain(".lodestone");
    expect(BUILTIN_IGNORE_PATTERNS).toContain(".lodestone/**");
  });

  // Codex impl-012 RED: a `.gitignore` containing `!.lodestone/**` (or any
  // negation that re-allows the runtime dir) MUST NOT be able to override
  // the hard self-watch guard. Otherwise the watcher → ingest → write →
  // watcher feedback loop is one operator typo away.
  it("HARD: .gitignore cannot negate .lodestone/** (self-watch guard)", () => {
    const m = buildIgnoreMatcher({
      cwd: tmp,
      inheritGitignore: true,
      extra: [],
      readGitignore: () => "!.lodestone/**\n!.lodestone\n",
    });
    expect(m.ignores(".lodestone/db.sqlite")).toBe(true);
    expect(m.ignores(".lodestone")).toBe(true);
    expect(m.ignores(".lodestone/feedback/x.json")).toBe(true);
  });

  it("HARD: extras cannot negate .lodestone/** (self-watch guard)", () => {
    const m = buildIgnoreMatcher({
      cwd: tmp,
      inheritGitignore: false,
      extra: ["!.lodestone/**", "!.lodestone"],
    });
    expect(m.ignores(".lodestone/db.sqlite")).toBe(true);
    expect(m.ignores(".lodestone")).toBe(true);
  });

  it("HARD: .git is also non-negotiable", () => {
    const m = buildIgnoreMatcher({
      cwd: tmp,
      inheritGitignore: true,
      extra: ["!.git/**"],
      readGitignore: () => "!.git\n",
    });
    expect(m.ignores(".git/HEAD")).toBe(true);
    expect(m.ignores(".git")).toBe(true);
  });

  it("HARD: node_modules is also non-negotiable", () => {
    const m = buildIgnoreMatcher({
      cwd: tmp,
      inheritGitignore: false,
      extra: ["!node_modules", "!node_modules/**"],
    });
    expect(m.ignores("node_modules/foo.js")).toBe(true);
  });

  it("HARD: nested .lodestone is also blocked", () => {
    const m = buildIgnoreMatcher({
      cwd: tmp,
      inheritGitignore: false,
      extra: ["!packages/x/.lodestone/**"],
    });
    // Even a nested .lodestone/ subtree is blocked — the runtime never
    // creates one but a friend's repo might. Defence in depth.
    expect(m.ignores("packages/x/.lodestone/db.sqlite")).toBe(true);
  });
});

describe("toRelPosix", () => {
  it("returns empty for cwd-self", () => {
    expect(toRelPosix("/a/b", "/a/b")).toBe("");
  });

  it("converts absolute path under cwd to relative POSIX", () => {
    const cwd = path.resolve("/tmp/foo");
    const abs = path.join(cwd, "src", "x.ts");
    expect(toRelPosix(cwd, abs)).toBe("src/x.ts");
  });

  it("returns empty for paths outside cwd", () => {
    expect(toRelPosix("/a/b", "/x/y")).toBe("");
  });
});

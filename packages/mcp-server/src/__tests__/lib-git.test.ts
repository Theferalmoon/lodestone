// SPDX-License-Identifier: Apache-2.0
// git.ts walker tests. Initialises a real git repo in a tempdir so we exercise
// the actual git binary; this is the same testing approach used elsewhere in
// the repo for git-aware code paths.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  GitUnavailableError,
  isGitRepo,
  resolveCommitTimestamp,
  walkLog,
} from "../lib/git.js";

let workdir: string;

function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: workdir,
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8",
  });
}

function commit(message: string, files: Record<string, string>): string {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(workdir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  git(["add", "."]);
  git(["commit", "-m", message]);
  return git(["rev-parse", "HEAD"]).trim();
}

beforeEach(() => {
  workdir = mkdtempSync(path.join(tmpdir(), "lodestone-git-"));
  git(["init", "--initial-branch=main", "--quiet"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test User"]);
  git(["config", "commit.gpgsign", "false"]);
});

afterEach(() => {
  try {
    rmSync(workdir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("isGitRepo", () => {
  it("returns true inside a git repo", () => {
    expect(isGitRepo(workdir)).toBe(true);
  });

  it("returns false in a non-git tempdir", () => {
    const nondir = mkdtempSync(path.join(tmpdir(), "lodestone-nogit-"));
    try {
      expect(isGitRepo(nondir)).toBe(false);
    } finally {
      rmSync(nondir, { recursive: true, force: true });
    }
  });
});

describe("resolveCommitTimestamp", () => {
  it("returns ms timestamp for a known commit", () => {
    const hash = commit("first", { "a.txt": "1" });
    const ms = resolveCommitTimestamp(workdir, hash);
    expect(ms).not.toBeNull();
    expect(typeof ms).toBe("number");
    expect((ms as number) > Date.parse("2020-01-01")).toBe(true);
  });

  it("returns null for an unknown hash", () => {
    commit("first", { "a.txt": "1" });
    expect(resolveCommitTimestamp(workdir, "0000000000")).toBeNull();
  });
});

describe("walkLog", () => {
  it("returns commits newest-first", () => {
    commit("first", { "a.txt": "1" });
    commit("second", { "b.txt": "2" });
    commit("third", { "c.txt": "3" });
    const records = walkLog({ cwd: workdir });
    expect(records.length).toBe(3);
    expect(records[0]!.subject).toBe("third");
    expect(records[1]!.subject).toBe("second");
    expect(records[2]!.subject).toBe("first");
  });

  it("populates files for each commit", () => {
    commit("multi", { "src/a.ts": "a", "src/b.ts": "b", "lib/c.ts": "c" });
    const [rec] = walkLog({ cwd: workdir });
    expect(rec).toBeDefined();
    expect(rec!.files.sort()).toEqual(["lib/c.ts", "src/a.ts", "src/b.ts"]);
  });

  it("respects sinceEpochMs cutoff", () => {
    commit("old", { "a.txt": "1" });
    // Sleep so the second commit lands at a measurably different timestamp.
    // git log --since uses second-resolution.
    const cutoff = Date.now() + 1500;
    while (Date.now() < cutoff) {
      // tight wait
    }
    commit("new", { "b.txt": "2" });
    const records = walkLog({ cwd: workdir, sinceEpochMs: cutoff });
    expect(records.length).toBe(1);
    expect(records[0]!.subject).toBe("new");
  });

  it("filters by paths via pathspec", () => {
    commit("touches src", { "src/a.ts": "a" });
    commit("touches lib", { "lib/b.ts": "b" });
    const records = walkLog({ cwd: workdir, paths: ["src/"] });
    expect(records.length).toBe(1);
    expect(records[0]!.subject).toBe("touches src");
  });

  it("returns empty array when no commits match window", () => {
    commit("only", { "a.txt": "1" });
    const records = walkLog({ cwd: workdir, sinceEpochMs: Date.now() + 10_000_000 });
    expect(records).toEqual([]);
  });

  it("respects maxCommits cap", () => {
    for (let i = 0; i < 5; i++) commit(`c${i}`, { [`f${i}.txt`]: String(i) });
    const records = walkLog({ cwd: workdir, maxCommits: 2 });
    expect(records.length).toBe(2);
  });

  it("handles commit subjects with special chars (pipes, quotes)", () => {
    commit('weird | subject "with quotes"', { "x.txt": "x" });
    const [rec] = walkLog({ cwd: workdir });
    expect(rec!.subject).toBe('weird | subject "with quotes"');
  });

  it("throws GitUnavailableError outside a repo", () => {
    const nondir = mkdtempSync(path.join(tmpdir(), "lodestone-nogit-"));
    try {
      expect(() => walkLog({ cwd: nondir })).toThrow(GitUnavailableError);
    } finally {
      rmSync(nondir, { recursive: true, force: true });
    }
  });
});

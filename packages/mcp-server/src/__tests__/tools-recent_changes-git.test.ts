// SPDX-License-Identifier: Apache-2.0
// recent_changes (RED #4) — git-aware commit-bucketed tests. Initialises a
// real git repo in the tempdir, writes some files + commits, and asserts
// the handler returns ChangeBucket-shaped results keyed by commit hash with
// per-file symbol summaries pulled from the SQLite index.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { LodestoneSymbol } from "@lodestone/shared";
import {
  _resetWriterRegistry,
  bootstrap,
  closeDb,
  openWriter,
  writeReady,
  writeSymbols,
  writeIndexMeta,
  } from "@lodestone/ingest/store";

import { handler, type ChangeBucket, type RecentChangeResult } from "../tools/recent_changes.js";
import type { LodestoneToolResponseV13 } from "../envelope.js";

let workdir: string;
let lodestoneDir: string;
let dbPath: string;
let prevCwd: string | undefined;
let commitOne = "";
let commitTwo = "";

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

function sym(id: string, overrides: Partial<LodestoneSymbol> = {}): LodestoneSymbol {
  return {
    symbol: id,
    path: `src/${id}.ts`,
    language: "typescript",
    kind: "function",
    range: { start_line: 1, end_line: 5 },
    signature: `function ${id}()`,
    ...overrides,
  };
}

function isBucket(r: RecentChangeResult): r is ChangeBucket {
  return typeof (r as ChangeBucket).commit === "string" && Array.isArray((r as ChangeBucket).files);
}

beforeEach(() => {
  workdir = mkdtempSync(path.join(tmpdir(), "lodestone-recent-git-"));
  lodestoneDir = path.join(workdir, ".lodestone");
  dbPath = path.join(lodestoneDir, "lodestone.sqlite");
  prevCwd = process.env.LODESTONE_CWD;
  process.env.LODESTONE_CWD = workdir;

  // Initialise a git repo so the handler takes the git-aware path.
  git(["init", "--initial-branch=main", "--quiet"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test User"]);
  git(["config", "commit.gpgsign", "false"]);

  // Two commits with distinct files. Sleep between so git timestamps
  // (1-second resolution) are measurably distinct.
  commitOne = commit("first commit — touch src/auth", {
    "src/auth.ts": "function login() {}\nfunction logout() {}\n",
  });
  const waitUntil = Date.now() + 1500;
  while (Date.now() < waitUntil) {
    /* tight wait for next-second clock */
  }
  commitTwo = commit("second commit — touch src/util", {
    "src/util.ts": "function formatStr() {}\n",
  });
});

afterEach(() => {
  if (prevCwd === undefined) delete process.env.LODESTONE_CWD;
  else process.env.LODESTONE_CWD = prevCwd;
  _resetWriterRegistry();
  try {
    rmSync(workdir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function seedIndex(): void {
  mkdirSync(lodestoneDir, { recursive: true });
  const db = openWriter(dbPath);
  bootstrap(db);
  writeIndexMeta(db, 2, { id: "nomic-text-v1.5", dim: 768, quant: "fp32" });
  // Seed symbols, attaching each to one of the two commits via the
  // updated_at_commit field (writeSymbols stamps it from ctx.commit).
  writeSymbols(
    db,
    [sym("login", { path: "src/auth.ts" }), sym("logout", { path: "src/auth.ts" })],
    { index_epoch: 1, commit: commitOne },
  );
  writeSymbols(db, [sym("formatStr", { path: "src/util.ts" })], {
    index_epoch: 2,
    commit: commitTwo,
  });
  closeDb(db);
  _resetWriterRegistry();
  writeReady(lodestoneDir, {
    schema_version: 1,
    lodestone_version: "0.1.0",
    ready: true,
    embedder: { id: "nomic-text-v1.5", dim: 768, quant: "fp32" },
    languages_indexed: ["typescript"],
    indexed_at: new Date().toISOString(),
    commit_at_index: commitTwo,
    dirty_at_index: false,
    index_epoch: 2,
    writer_pid: process.pid,
  });
}

describe("recent_changes — git-aware bucketed path", () => {
  it("returns ChangeBucket-shaped results when project is a git repo", async () => {
    seedIndex();
    const res = (await handler({})) as LodestoneToolResponseV13<RecentChangeResult>;
    expect(res.results.length).toBeGreaterThanOrEqual(2);
    // Newest first: commitTwo bucket should be first.
    expect(isBucket(res.results[0]!)).toBe(true);
    const first = res.results[0] as ChangeBucket;
    expect(first.commit).toBe(commitTwo);
    expect(first.subject).toMatch(/second commit/);
    expect(first.files.length).toBe(1);
    expect(first.files[0]!.path).toBe("src/util.ts");
    expect(first.files[0]!.symbols.some((s) => s.symbol === "formatStr")).toBe(true);
  });

  it("emits a not_git_repo warning fallback when not in a git repo", async () => {
    // Wipe the git dir to break repo detection.
    rmSync(path.join(workdir, ".git"), { recursive: true, force: true });
    seedIndex();
    const res = await handler({});
    expect(
      (res.diagnostics.warnings ?? []).some((w) => /not_git_repo/.test(w)),
    ).toBe(true);
    // Fallback shape: each row has `symbol` not `commit`.
    if (res.results.length > 0) {
      expect(isBucket(res.results[0]!)).toBe(false);
    }
  });

  it("filters by paths via pathspec — only commits touching the path appear", async () => {
    seedIndex();
    const res = await handler({ paths: ["src/util.ts"] });
    // Only commitTwo touches src/util.ts.
    expect(res.results.length).toBe(1);
    const b = res.results[0] as ChangeBucket;
    expect(b.commit).toBe(commitTwo);
    expect(b.files.every((f) => f.path === "src/util.ts")).toBe(true);
  });

  it("filters by `since` commit hash", async () => {
    seedIndex();
    // since=commitTwo means "commits at-or-after commitTwo's timestamp".
    // Only commitTwo itself qualifies.
    const res = await handler({ since: commitTwo });
    expect(res.results.length).toBe(1);
    expect((res.results[0] as ChangeBucket).commit).toBe(commitTwo);
  });

  it("filters by `since` ISO timestamp", async () => {
    seedIndex();
    // Cutoff well in the future returns nothing.
    const res = await handler({ since: "2099-01-01T00:00:00Z" });
    expect(res.results).toEqual([]);
  });

  it("each bucket includes commit subject + author + ISO timestamp", async () => {
    seedIndex();
    const res = await handler({});
    const bucket = res.results[0] as ChangeBucket;
    expect(bucket.subject.length).toBeGreaterThan(0);
    expect(bucket.author).toBe("Test User");
    expect(() => new Date(bucket.timestamp).toISOString()).not.toThrow();
  });

  it("symbols inside bucket show kind/range/summary", async () => {
    seedIndex();
    const res = await handler({});
    const bucket = res.results.find(
      (r): r is ChangeBucket => isBucket(r) && (r as ChangeBucket).commit === commitOne,
    );
    expect(bucket).toBeDefined();
    const file = bucket!.files.find((f) => f.path === "src/auth.ts");
    expect(file).toBeDefined();
    const login = file!.symbols.find((s) => s.symbol === "login");
    expect(login).toBeDefined();
    expect(login!.kind).toBe("function");
    expect(login!.summary).toContain("function");
    expect(login!.range.start_line).toBe(1);
  });
});

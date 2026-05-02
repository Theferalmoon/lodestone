// SPDX-License-Identifier: Apache-2.0
// Tests for tools/context.ts. Builds a small fixture graph + cluster, then
// exercises every code path of the §15 context handler: fully-qualified hit,
// fully-qualified miss, file-path summary, bare-name disambiguation, no-DB
// failure mode, and registered tool description length.
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  _resetWriterRegistry,
  bootstrap,
  closeDb,
  openWriter,
  writeEdges,
  writePagerank,
  writeReady,
  writeSymbols,
} from "@lodestone/ingest/store";
import { buildGraph, pageRank } from "@lodestone/ingest/graph";
import type { Edge, LodestoneSymbol } from "@lodestone/shared";

import { _setTestDbPath } from "../tools/db.js";
import { classifyInput, description, handler } from "../tools/context.js";

let tmp: string;
let dbPath: string;

function sym(id: string, filePath: string): LodestoneSymbol {
  return {
    symbol: id,
    path: filePath,
    language: "typescript",
    kind: "function",
    range: { start_line: 1, end_line: 5 },
  };
}

/**
 * Fixture call-graph + a cluster:
 *
 *   src/auth/user.ts::User::login -> src/auth/session.ts::createSession
 *   src/api/handler.ts::handleLogin -> src/auth/user.ts::User::login
 *   src/auth/user.ts::User::logout (no callers)
 *
 * "User" appears as a bare name in src/models/user.ts::User and
 * src/auth/user.ts::User to exercise disambiguation.
 */
function seedFixture(dbPath: string): void {
  const db = openWriter(dbPath);
  bootstrap(db);
  const symbols: LodestoneSymbol[] = [
    sym("src/auth/user.ts::User::login", "src/auth/user.ts"),
    sym("src/auth/user.ts::User::logout", "src/auth/user.ts"),
    sym("src/auth/session.ts::createSession", "src/auth/session.ts"),
    sym("src/api/handler.ts::handleLogin", "src/api/handler.ts"),
    sym("src/auth/user.ts::User", "src/auth/user.ts"),
    sym("src/models/user.ts::User", "src/models/user.ts"),
  ];
  const edges: Edge[] = [
    { from: "src/auth/user.ts::User::login", to: "src/auth/session.ts::createSession", kind: "calls" },
    { from: "src/api/handler.ts::handleLogin", to: "src/auth/user.ts::User::login", kind: "calls" },
    // imports: file-level imports modeled symbol-to-symbol for v0.
    { from: "src/api/handler.ts::handleLogin", to: "src/auth/user.ts::User::login", kind: "imports" },
  ];
  writeSymbols(db, symbols, { index_epoch: 1 });
  const graph = buildGraph({ symbols, edges });
  writeEdges(db, graph);
  writePagerank(db, pageRank(graph), graph);

  // Insert a cluster and link login/logout into it so the cluster_id /
  // cluster_name fields populate.
  db.prepare(
    "INSERT INTO clusters (id, name, name_status, size, algorithm, algorithm_version, index_epoch) VALUES (?,?,?,?,?,?,?)",
  ).run("cl-auth", "auth", "heuristic", 2, "louvain", "test", 1);
  db.prepare("UPDATE symbols SET cluster_id = ? WHERE id = ?").run(
    "cl-auth",
    "src/auth/user.ts::User::login",
  );
  db.prepare(
    "INSERT INTO cluster_members (cluster_id, symbol_id, is_bridge) VALUES (?, ?, ?)",
  ).run("cl-auth", "src/auth/user.ts::User::login", 0);
  closeDb(db);
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "lodestone-context-test-"));
  const lodestoneDir = path.join(tmp, ".lodestone");
  mkdirSync(lodestoneDir, { recursive: true });
  dbPath = path.join(lodestoneDir, "lodestone.sqlite");
  seedFixture(dbPath);
  writeReady(path.dirname(dbPath), {
    schema_version: 2,
    lodestone_version: "0.1.1",
    ready: true,
    embedder: { id: "nomic-text-v1.5", dim: 768, quant: "fp32" },
    languages_indexed: ["typescript"],
    indexed_at: "2026-05-02T00:00:00Z",
    commit_at_index: null,
    dirty_at_index: false,
    index_epoch: 1,
    writer_pid: process.pid,
  });
  _resetWriterRegistry();
  _setTestDbPath(dbPath);
});

afterEach(() => {
  _setTestDbPath(null);
  _resetWriterRegistry();
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

describe("classifyInput (§15 lexical resolver)", () => {
  it("recognises fully-qualified ids by '::'", () => {
    expect(classifyInput("src/foo.ts::Foo::bar")).toBe("fully_qualified");
  });
  it("recognises file paths by '/'", () => {
    expect(classifyInput("src/foo.ts")).toBe("file_path");
  });
  it("recognises file paths by extension", () => {
    expect(classifyInput("foo.py")).toBe("file_path");
    expect(classifyInput("foo.rs")).toBe("file_path");
  });
  it("treats anything else as a bare name", () => {
    expect(classifyInput("User")).toBe("bare_name");
    expect(classifyInput("doStuff")).toBe("bare_name");
  });
});

describe("context tool (§15)", () => {
  it("returns SymbolContext with callers/callees for a fully-qualified hit", async () => {
    const env = await handler({ symbol: "src/auth/user.ts::User::login" });
    expect(env.results.length).toBe(1);
    const ctx = env.results[0] as {
      symbol: string;
      defined_at: { path: string; range: { start_line: number; end_line: number } };
      callers: Array<{ symbol: string }>;
      callees: Array<{ symbol: string }>;
      cluster_id?: string;
      cluster_name?: string;
    };
    expect(ctx.symbol).toBe("src/auth/user.ts::User::login");
    expect(ctx.defined_at.path).toBe("src/auth/user.ts");
    expect(ctx.callers.map((c) => c.symbol)).toContain(
      "src/api/handler.ts::handleLogin",
    );
    expect(ctx.callees.map((c) => c.symbol)).toContain(
      "src/auth/session.ts::createSession",
    );
    expect(ctx.cluster_id).toBe("cl-auth");
    expect(ctx.cluster_name).toBe("auth");
  });

  it("returns empty results (not error) for a fully-qualified miss", async () => {
    const env = await handler({ symbol: "src/nope.ts::Nope::nope" });
    expect(env.results).toEqual([]);
    // No 'not_implemented' warning either — this is a clean empty hit.
    expect(env.diagnostics.warnings ?? []).not.toContain("not_implemented");
  });

  it("returns SymbolMatches with disambiguation for a bare name", async () => {
    const env = await handler({ symbol: "User" });
    expect(env.results.length).toBe(1);
    const matches = env.results[0] as {
      matches: Array<{ symbol: string }>;
      suggestion: string;
    };
    expect(matches.matches.map((m) => m.symbol).sort()).toEqual([
      "src/auth/user.ts::User",
      "src/models/user.ts::User",
    ]);
    expect(matches.suggestion).toMatch(/Multiple matches for 'User'/);
    expect(matches.suggestion).toMatch(/fully-qualified/);
  });

  it("returns helpful empty-matches suggestion for a bare-name miss", async () => {
    const env = await handler({ symbol: "Nonexistent" });
    expect(env.results.length).toBe(1);
    const matches = env.results[0] as {
      matches: Array<unknown>;
      suggestion: string;
    };
    expect(matches.matches).toEqual([]);
    expect(matches.suggestion).toMatch(/No symbol named 'Nonexistent'/);
  });

  it("returns a file-level SymbolContext for a known file path", async () => {
    const env = await handler({ symbol: "src/auth/user.ts" });
    expect(env.results.length).toBe(1);
    const ctx = env.results[0] as {
      symbol: string;
      callers: Array<{ symbol: string }>;
      callees: Array<{ symbol: string }>;
    };
    expect(ctx.symbol).toBe("src/auth/user.ts");
    // handleLogin lives in another file → caller of one of the file's
    // symbols, so it shows up in the file-level callers list.
    expect(ctx.callers.map((c) => c.symbol)).toContain(
      "src/api/handler.ts::handleLogin",
    );
    // createSession is called from inside the file → file-level callees.
    expect(ctx.callees.map((c) => c.symbol)).toContain(
      "src/auth/session.ts::createSession",
    );
  });

  it("returns empty results for an unknown file path", async () => {
    const env = await handler({ symbol: "src/nope.ts" });
    expect(env.results).toEqual([]);
  });

  it("rejects invalid input (empty string) with a structured warning", async () => {
    const env = await handler({ symbol: "" });
    expect(env.results).toEqual([]);
    expect(env.diagnostics.warnings ?? []).toEqual([
      expect.stringMatching(/invalid input/),
    ]);
  });

  it("returns a clean error envelope when the index is missing", async () => {
    _setTestDbPath(path.join(tmp, "does-not-exist.sqlite"));
    const env = await handler({ symbol: "src/auth/user.ts::User::login" });
    expect(env.results).toEqual([]);
    expect(env.diagnostics.warnings ?? []).toEqual([
      expect.stringMatching(/index unavailable/),
    ]);
  });

  it("description is >=150 chars (Claude Code tool-search retrieval gate)", () => {
    expect(description.length).toBeGreaterThanOrEqual(150);
  });

  it("envelope channel is 'code' (POST-FORGE-VISION amendment §2)", async () => {
    const env = await handler({ symbol: "src/auth/user.ts::User::login" });
    expect(env.channel).toBe("code");
  });
});

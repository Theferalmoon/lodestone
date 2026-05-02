// SPDX-License-Identifier: Apache-2.0
// query.ts (§14) tests. Builds a real bootstrap'd SQLite + sqlite-vec store in
// a tempdir, seeds a tiny fixture (5 symbols + embeddings), points the tool at
// the tempdir via LODESTONE_CWD, injects a deterministic embedder, and
// exercises the handler end-to-end.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { LodestoneSymbol } from "@lodestone/shared";
import {
  _resetWriterRegistry,
  bootstrap,
  closeDb,
  openWriter,
  writeEmbeddings,
  writeReady,
  writeSymbols,
} from "@lodestone/ingest/store";
import type { EmbedderHandle } from "@lodestone/ingest/embed";

import { handler, __setEmbedderForTests, type QueryHit } from "../tools/query.js";
import type { LodestoneToolResponseV13 } from "../envelope.js";

let workdir: string;
let lodestoneDir: string;
let dbPath: string;
let prevCwd: string | undefined;

function fakeEmbedder(byId: Record<string, Float32Array>, fallback: Float32Array): EmbedderHandle {
  return {
    id: "nomic-text-v1.5" as const,
    dim: 768,
    maxBatch: 1,
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map((t) => byId[t] ?? fallback);
    },
    async dispose(): Promise<void> {},
  };
}

function vec(fill: number): Float32Array {
  const v = new Float32Array(768);
  v.fill(fill);
  return v;
}

function sym(id: string, overrides: Partial<LodestoneSymbol> = {}): LodestoneSymbol {
  return {
    symbol: id,
    path: `src/${id}.ts`,
    language: "typescript",
    kind: "function",
    range: { start_line: 1, end_line: 5 },
    signature: `function ${id}()`,
    docstring: `${id} doc`,
    ...overrides,
  };
}

function seed(): void {
  mkdirSync(lodestoneDir, { recursive: true });
  const db = openWriter(dbPath);
  bootstrap(db);
  const symbols: LodestoneSymbol[] = [
    sym("auth_login", { signature: "function login(user)", docstring: "authentication entry point" }),
    sym("auth_logout", { signature: "function logout(user)", docstring: "tear down session" }),
    sym("py_helper", {
      path: "lib/helper.py",
      language: "python",
      signature: "def helper()",
      docstring: "python helper",
    }),
    sym("util_format", {
      path: "src/util/format.ts",
      signature: "function format(input)",
      docstring: "string formatter",
    }),
    sym("legacy_old", {
      path: "legacy/old.ts",
      signature: "function old()",
      docstring: "legacy",
    }),
  ];
  writeSymbols(db, symbols, { index_epoch: 1, commit: "abc1234" });

  // Seed embeddings — auth_login at vec(0.0), all others at vec(1.0). A query
  // vector of vec(0.05) will rank auth_login first.
  writeEmbeddings(db, [
    { symbol_id: "auth_login", vector: vec(0.0) },
    { symbol_id: "auth_logout", vector: vec(0.5) },
    { symbol_id: "py_helper", vector: vec(1.0) },
    { symbol_id: "util_format", vector: vec(0.7) },
    { symbol_id: "legacy_old", vector: vec(0.9) },
  ]);
  closeDb(db);
  _resetWriterRegistry();

  writeReady(lodestoneDir, {
    schema_version: 1,
    lodestone_version: "0.1.0",
    ready: true,
    embedder: { id: "nomic-text-v1.5", dim: 768, quant: "fp32" },
    languages_indexed: ["typescript", "python"],
    indexed_at: new Date().toISOString(),
    commit_at_index: "abc1234",
    dirty_at_index: false,
    index_epoch: 1,
    writer_pid: process.pid,
  });
}

beforeEach(() => {
  workdir = mkdtempSync(path.join(tmpdir(), "lodestone-mcp-query-"));
  lodestoneDir = path.join(workdir, ".lodestone");
  dbPath = path.join(lodestoneDir, "lodestone.sqlite");
  prevCwd = process.env.LODESTONE_CWD;
  process.env.LODESTONE_CWD = workdir;
  __setEmbedderForTests(fakeEmbedder({}, vec(0.05)));
});

afterEach(() => {
  __setEmbedderForTests(null);
  if (prevCwd === undefined) delete process.env.LODESTONE_CWD;
  else process.env.LODESTONE_CWD = prevCwd;
  _resetWriterRegistry();
  try {
    rmSync(workdir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

describe("query handler — readiness gate", () => {
  it("returns wrapNotReady envelope when ready.json is absent", async () => {
    // Bootstrap DB but DON'T write ready.json.
    mkdirSync(lodestoneDir, { recursive: true });
    const db = openWriter(dbPath);
    bootstrap(db);
    closeDb(db);
    _resetWriterRegistry();
    const res = await handler({ question: "hello" });
    expect(res.results).toEqual([]);
    expect(res.diagnostics.warnings ?? []).toContain("index not ready, see lodestone status");
  });

  it("returns an error envelope when the SQLite file does not exist", async () => {
    const res = (await handler({ question: "hello" })) as LodestoneToolResponseV13<QueryHit>;
    expect(res.results).toEqual([]);
    expect(res.diagnostics.warnings?.some((w) => /lodestone init/.test(w))).toBe(true);
  });
});

describe("query handler — input validation", () => {
  it("rejects empty question with a clear error before any retrieval", async () => {
    seed();
    const res = await handler({ question: "" });
    expect(res.results).toEqual([]);
    expect(res.diagnostics.warnings?.[0]).toMatch(/non-empty/);
  });

  it("rejects top_k=0 with a clear error", async () => {
    seed();
    const res = await handler({ question: "auth", top_k: 0 });
    expect(res.results).toEqual([]);
    expect(res.diagnostics.warnings?.[0]).toMatch(/(>=|greater than)/i);
  });

  it("silently clamps top_k > 50 and reports diagnostics.clamped", async () => {
    seed();
    const res = await handler({ question: "auth", top_k: 999 });
    // Real top_k cap = 50 → at most 5 fixture rows returned.
    expect(res.results.length).toBeLessThanOrEqual(50);
    expect(res.diagnostics.clamped).toBe(true);
  });
});

describe("query handler — retrieval + ranking", () => {
  it("returns vector-ranked hits with auth_login first for the auth-aligned query vector", async () => {
    seed();
    const res = await handler({ question: "authentication login flow", top_k: 5 });
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.results[0]!.symbol).toBe("auth_login");
    expect(res.results[0]!.score).toBe(1);
    expect(res.results[0]!.reasons).toEqual(expect.arrayContaining(["vector"]));
  });

  it("populates QueryHit shape with snippet + range + cluster_id null", async () => {
    seed();
    const res = await handler({ question: "authentication" });
    const hit = res.results[0]!;
    expect(hit.path).toBe("src/auth_login.ts");
    expect(hit.range).toEqual({ start_line: 1, end_line: 5 });
    expect(hit.snippet).toContain("login");
    expect(hit.cluster_id).toBeNull();
    expect(hit.language).toBe("typescript");
  });

  it("filters.languages=['python'] excludes typescript hits", async () => {
    seed();
    const res = await handler({ question: "helper format", filters: { languages: ["python"] } });
    expect(res.results.every((h) => h.language === "python")).toBe(true);
    expect(res.results.some((h) => h.symbol === "py_helper")).toBe(true);
  });

  it("filters.paths=['src/**'] excludes results outside src/", async () => {
    seed();
    const res = await handler({ question: "helper format old legacy", filters: { paths: ["src/**"] } });
    for (const hit of res.results) {
      expect(hit.path.startsWith("src/")).toBe(true);
    }
    expect(res.results.some((h) => h.symbol === "legacy_old")).toBe(false);
    expect(res.results.some((h) => h.symbol === "py_helper")).toBe(false);
  });

  it("reasons lists 'lexical' for hits surfaced by the LIKE lane only", async () => {
    seed();
    // Use a unique signature term that LIKE matches but the fake embedder
    // doesn't disambiguate.
    const res = await handler({ question: "format" });
    const formatHit = res.results.find((h) => h.symbol === "util_format");
    expect(formatHit).toBeDefined();
    expect(formatHit!.reasons).toEqual(expect.arrayContaining(["lexical"]));
  });
});

describe("query handler — provenance", () => {
  it("populates provenance from ready.json marker", async () => {
    seed();
    const res = await handler({ question: "auth" });
    expect(res.provenance.is_git_repo).toBe(true);
    expect(res.provenance.head_commit).toBe("abc1234");
    expect(res.provenance.indexed_commit).toBe("abc1234");
    expect(res.provenance.index_epoch).toBe(1);
    expect(res.provenance.staleness_seconds).toBeGreaterThanOrEqual(0);
    expect(["live", "stale"]).toContain(res.provenance.source);
  });

  it("envelope carries channel='code' and a request_id", async () => {
    seed();
    const res = await handler({ question: "auth" });
    expect(res.channel).toBe("code");
    expect(res.request_id).toMatch(/-/);
  });
});

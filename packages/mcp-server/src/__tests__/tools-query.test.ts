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
  writeIndexMeta,
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
  writeIndexMeta(db, 1, { id: "nomic-text-v1.5", dim: 768, quant: "fp32" });
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
    writeIndexMeta(db, 1, { id: "nomic-text-v1.5", dim: 768, quant: "fp32" });
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

// ── Codex impl-014 RED #1: vector lane is OPTIONAL ───────────────────────────
describe("query handler — vector-lane degradation (RED #1)", () => {
  it("returns lexical-only results + warning when embedder load fails", async () => {
    seed();
    // Simulate load failure: setting cachedEmbedder to null then forcing the
    // production loader to throw via __setEmbedderForTests semantics. The
    // simplest test hook: inject an embedder whose embed() throws.
    __setEmbedderForTests({
      id: "broken" as const,
      dim: 768,
      maxBatch: 1,
      async embed(): Promise<Float32Array[]> {
        throw new Error("simulated weights-missing");
      },
      async dispose() {},
    });
    const res = await handler({ question: "authentication", top_k: 5 });
    // We must still have lexical results — auth_login matches by signature.
    expect(res.results.length).toBeGreaterThan(0);
    // And a warning explaining the vector lane is off.
    expect(res.diagnostics.warnings ?? []).toEqual(
      expect.arrayContaining([expect.stringMatching(/vector lane disabled/i)]),
    );
    // None of the surviving hits report vector as a reason.
    for (const hit of res.results) {
      expect(hit.reasons).not.toContain("vector");
      expect(hit.reasons).toContain("lexical");
    }
  });

  it("returns lexical-only when embedder returns no vectors", async () => {
    seed();
    __setEmbedderForTests({
      id: "empty" as const,
      dim: 768,
      maxBatch: 1,
      async embed(): Promise<Float32Array[]> {
        return [];
      },
      async dispose() {},
    });
    const res = await handler({ question: "authentication" });
    expect(res.diagnostics.warnings ?? []).toEqual(
      expect.arrayContaining([expect.stringMatching(/vector lane disabled/i)]),
    );
    // Lexical lane still produced hits.
    expect(res.results.length).toBeGreaterThan(0);
  });
});

// ── Codex impl-014 RED #2: filter pushdown produces non-empty results ────────
describe("query handler — filter pushdown (RED #2)", () => {
  it("paths filter does not lose admissible candidates to LIMIT-before-filter", async () => {
    // Seed enough symbols that a naive top-N-then-filter would empty out.
    mkdirSync(lodestoneDir, { recursive: true });
    const { openWriter, bootstrap, writeSymbols, writeReady, _resetWriterRegistry, closeDb, writeEmbeddings } =
      await import("@lodestone/ingest/store");
    const db = openWriter(dbPath);
    bootstrap(db);
    writeIndexMeta(db, 1, { id: "nomic-text-v1.5", dim: 768, quant: "fp32" });
    // 50 noise symbols outside src/, all matching "format" — they would
    // monopolize a naive LIMIT-then-filter result list.
    const noise: LodestoneSymbol[] = [];
    for (let i = 0; i < 50; i++) {
      noise.push({
        symbol: `noise_${i}`,
        path: `legacy/noise_${i}.ts`,
        language: "typescript",
        kind: "function",
        range: { start_line: 1, end_line: 5 },
        signature: `function format_${i}()`,
        docstring: `formatter noise ${i}`,
      });
    }
    // One needle symbol inside src/ that also matches.
    const needle: LodestoneSymbol = {
      symbol: "needle_format",
      path: "src/needle/format.ts",
      language: "typescript",
      kind: "function",
      range: { start_line: 1, end_line: 5 },
      signature: "function format_needle()",
      docstring: "the needle",
    };
    writeSymbols(db, [...noise, needle], { index_epoch: 1, commit: "abc1234" });
    // Embeddings for everything so the vector lane participates.
    writeEmbeddings(
      db,
      [...noise, needle].map((s, i) => ({ symbol_id: s.symbol, vector: vec(i / 100) })),
    );
    closeDb(db);
    _resetWriterRegistry();
    writeReady(lodestoneDir, {
      schema_version: 1,
      lodestone_version: "0.1.0",
      ready: true,
      embedder: { id: "nomic-text-v1.5", dim: 768, quant: "fp32" },
      languages_indexed: ["typescript"],
      indexed_at: new Date().toISOString(),
      commit_at_index: "abc1234",
      dirty_at_index: false,
      index_epoch: 1,
      writer_pid: process.pid,
    });

    const res = await handler({
      question: "format",
      top_k: 5,
      filters: { paths: ["src/**"] },
    });
    // The needle MUST surface — pre-fix, the lexical+vector lanes would have
    // grabbed all 50 noise rows (which are pagerank-tied) and post-filter
    // would have dropped every hit, returning empty.
    expect(res.results.some((h) => h.symbol === "needle_format")).toBe(true);
  });
});

// ── Codex impl-014 RED #3: real `since` semantics ────────────────────────────
describe("query handler — `since` filter (RED #3)", () => {
  it("rejects malformed since with a clear error envelope", async () => {
    seed();
    const res = await handler({ question: "auth", filters: { since: "yesterday-ish" } });
    expect(res.results).toEqual([]);
    expect(res.diagnostics.warnings?.[0]).toMatch(/Malformed `since`/);
  });

  it("accepts ISO timestamp without throwing", async () => {
    seed();
    const res = await handler({ question: "auth", filters: { since: "2020-01-01" } });
    // Cutoff is in the past — but rows have commit hashes that don't resolve
    // in this non-git tempdir, so they all get filtered out and we get an
    // empty result list. Either is fine; the assertion is "no malformed
    // error".
    expect(
      (res.diagnostics.warnings ?? []).some((w) => /Malformed `since`/.test(w)),
    ).toBe(false);
  });

  it("accepts a relative duration without throwing", async () => {
    seed();
    const res = await handler({ question: "auth", filters: { since: "1 week ago" } });
    expect(
      (res.diagnostics.warnings ?? []).some((w) => /Malformed `since`/.test(w)),
    ).toBe(false);
  });

  it("accepts a commit hash; warns when not in a git repo", async () => {
    seed();
    const res = await handler({ question: "auth", filters: { since: "abc1234" } });
    // Tempdir is not a git repo, so the commit-hash-since path warns instead
    // of throwing.
    expect(
      (res.diagnostics.warnings ?? []).some((w) => /git repository|not found/.test(w)),
    ).toBe(true);
  });
});

// ── Codex impl-014 YELLOW: source-window snippets ────────────────────────────
describe("query handler — source-window snippets (YELLOW)", () => {
  it("returns source lines from disk when the file exists", async () => {
    // Seed a real file on disk inside the tempdir at the same relative path
    // the symbols table records.
    seed();
    const realPath = path.join(workdir, "src/auth_login.ts");
    mkdirSync(path.dirname(realPath), { recursive: true });
    const { writeFileSync } = await import("node:fs");
    const lines = [
      "// header comment",
      "export function login(user) {",
      "  return authenticate(user);",
      "}",
      "// trailing",
    ];
    writeFileSync(realPath, lines.join("\n"));
    const res = await handler({ question: "authentication" });
    const hit = res.results.find((h) => h.symbol === "auth_login");
    expect(hit).toBeDefined();
    // Snippet should contain the actual function body lines, not just signature.
    expect(hit!.snippet).toContain("authenticate(user)");
  });
});

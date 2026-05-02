// SPDX-License-Identifier: Apache-2.0
// recent_changes.ts (§14) tests. Same fixture setup as tools-query.test.ts:
// real bootstrap'd SQLite store in a tempdir, LODESTONE_CWD pointed at it,
// then seed N symbols across multiple ingest epochs and assert the freshest
// rows surface first.

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
  writeReady,
  writeSymbols,
} from "@lodestone/ingest/store";

import { handler, type RecentChangedSymbol } from "../tools/recent_changes.js";
import type { LodestoneToolResponseV13 } from "../envelope.js";

let workdir: string;
let lodestoneDir: string;
let dbPath: string;
let prevCwd: string | undefined;

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

/** Seed three batches at three different epochs so the rows have a clear
 * recency ordering: epoch 3 > epoch 2 > epoch 1. */
function seed(): void {
  mkdirSync(lodestoneDir, { recursive: true });
  const db = openWriter(dbPath);
  bootstrap(db);
  writeSymbols(db, [sym("oldest_a"), sym("oldest_b")], { index_epoch: 1, commit: "c1" });
  writeSymbols(db, [sym("middle_a"), sym("middle_b")], { index_epoch: 2, commit: "c2" });
  writeSymbols(db, [sym("newest_a"), sym("newest_b"), sym("newest_c")], {
    index_epoch: 3,
    commit: "c3",
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
    commit_at_index: "c3",
    dirty_at_index: false,
    index_epoch: 3,
    writer_pid: process.pid,
  });
}

beforeEach(() => {
  workdir = mkdtempSync(path.join(tmpdir(), "lodestone-mcp-recent-"));
  lodestoneDir = path.join(workdir, ".lodestone");
  dbPath = path.join(lodestoneDir, "lodestone.sqlite");
  prevCwd = process.env.LODESTONE_CWD;
  process.env.LODESTONE_CWD = workdir;
});

afterEach(() => {
  if (prevCwd === undefined) delete process.env.LODESTONE_CWD;
  else process.env.LODESTONE_CWD = prevCwd;
  _resetWriterRegistry();
  try {
    rmSync(workdir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

describe("recent_changes handler — readiness gate", () => {
  it("returns wrapNotReady envelope when ready.json is absent", async () => {
    mkdirSync(lodestoneDir, { recursive: true });
    const db = openWriter(dbPath);
    bootstrap(db);
    closeDb(db);
    _resetWriterRegistry();
    const res = await handler({});
    expect(res.results).toEqual([]);
    expect(res.diagnostics.warnings ?? []).toContain("index not ready, see lodestone status");
  });

  it("returns an error envelope when the SQLite file does not exist", async () => {
    const res = (await handler({})) as LodestoneToolResponseV13<RecentChangedSymbol>;
    expect(res.results).toEqual([]);
    expect(res.diagnostics.warnings?.some((w) => /lodestone init/.test(w))).toBe(true);
  });
});

describe("recent_changes handler — input validation + clamping", () => {
  it("rejects top_k=0", async () => {
    seed();
    const res = await handler({ top_k: 0 });
    expect(res.results).toEqual([]);
    expect(res.diagnostics.warnings?.[0]).toMatch(/(>=|greater than)/i);
  });

  it("silently clamps top_k > 50 and reports diagnostics.clamped", async () => {
    seed();
    const res = await handler({ top_k: 200 });
    expect(res.results.length).toBeLessThanOrEqual(50);
    expect(res.diagnostics.clamped).toBe(true);
  });

  it("`since` is accepted but adds a v0-limitation warning", async () => {
    seed();
    const res = await handler({ since: "2026-01-01T00:00:00Z" });
    expect(res.diagnostics.warnings?.some((w) => /best-effort/.test(w))).toBe(true);
  });
});

describe("recent_changes handler — recency ordering", () => {
  it("returns the freshest symbols first (highest updated_at_epoch)", async () => {
    seed();
    const res = await handler({ top_k: 10 });
    expect(res.results[0]!.updated_at_epoch).toBe(3);
    // First three rows must be the epoch-3 batch.
    const top3 = res.results.slice(0, 3).map((r) => r.symbol).sort();
    expect(top3).toEqual(["newest_a", "newest_b", "newest_c"]);
  });

  it("default top_k=20 returns all 7 fixture rows", async () => {
    seed();
    const res = await handler({});
    expect(res.results.length).toBe(7);
  });

  it("top_k=2 returns exactly 2 rows", async () => {
    seed();
    const res = await handler({ top_k: 2 });
    expect(res.results.length).toBe(2);
    expect(res.results.every((r) => r.updated_at_epoch === 3)).toBe(true);
  });

  it("each row includes commit + cluster_id + summary", async () => {
    seed();
    const res = await handler({ top_k: 1 });
    const r = res.results[0]!;
    expect(r.updated_at_commit).toBe("c3");
    expect(r.cluster_id).toBeNull();
    expect(r.summary).toContain("function");
    expect(r.path).toMatch(/^src\//);
    expect(r.range).toEqual({ start_line: 1, end_line: 5 });
  });
});

describe("recent_changes handler — provenance + envelope", () => {
  it("populates provenance from ready.json", async () => {
    seed();
    const res = await handler({});
    expect(res.provenance.is_git_repo).toBe(true);
    expect(res.provenance.head_commit).toBe("c3");
    expect(res.provenance.index_epoch).toBe(3);
  });

  it("envelope carries channel='code' and a request_id", async () => {
    seed();
    const res = await handler({});
    expect(res.channel).toBe("code");
    expect(res.request_id).toMatch(/-/);
  });
});

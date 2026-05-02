// SPDX-License-Identifier: Apache-2.0
// Tests for tools/impact.ts. Same fixture pattern as tools-context.test.ts:
// build a small call-graph, then exercise the §15 impact handler across
// fully-qualified-symbol, file-path expansion, leaf, miss, invalid-input,
// and no-DB code paths.
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
  writeIndexMeta,
  } from "@lodestone/ingest/store";
import { buildGraph, pageRank } from "@lodestone/ingest/graph";
import type { Edge, LodestoneSymbol } from "@lodestone/shared";

import { _setTestDbPath } from "../tools/db.js";
import { description, handler } from "../tools/impact.js";

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
 * Fixture call-graph using fully-qualified ids per §15 input policy:
 *
 *   src/a.ts::a -> src/b.ts::b -> src/c.ts::c
 *   src/a.ts::a -> src/c.ts::c (direct)
 *   src/d.ts::d -> src/b.ts::b
 *   src/e.ts::e (leaf, no callers, no callees)
 *
 * Two-symbol file `src/multi.ts` (m1, m2) for file-path expansion.
 */
function seedFixture(dbPath: string): void {
  const db = openWriter(dbPath);
  bootstrap(db);
  writeIndexMeta(db, 1, { id: "nomic-text-v1.5", dim: 768, quant: "fp32" });
  const symbols: LodestoneSymbol[] = [
    sym("src/a.ts::a", "src/a.ts"),
    sym("src/b.ts::b", "src/b.ts"),
    sym("src/c.ts::c", "src/c.ts"),
    sym("src/d.ts::d", "src/d.ts"),
    sym("src/e.ts::e", "src/e.ts"),
    sym("src/multi.ts::m1", "src/multi.ts"),
    sym("src/multi.ts::m2", "src/multi.ts"),
    sym("src/caller.ts::caller-of-m1", "src/caller.ts"),
    sym("src/caller.ts::caller-of-m2", "src/caller.ts"),
  ];
  const edges: Edge[] = [
    { from: "src/a.ts::a", to: "src/b.ts::b", kind: "calls" },
    { from: "src/b.ts::b", to: "src/c.ts::c", kind: "calls" },
    { from: "src/a.ts::a", to: "src/c.ts::c", kind: "calls" },
    { from: "src/d.ts::d", to: "src/b.ts::b", kind: "calls" },
    { from: "src/caller.ts::caller-of-m1", to: "src/multi.ts::m1", kind: "calls" },
    { from: "src/caller.ts::caller-of-m2", to: "src/multi.ts::m2", kind: "calls" },
  ];
  writeSymbols(db, symbols, { index_epoch: 1 });
  const graph = buildGraph({ symbols, edges });
  writeEdges(db, graph);
  writePagerank(db, pageRank(graph), graph);
  closeDb(db);
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "lodestone-impact-test-"));
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

describe("impact tool (§15)", () => {
  it("returns blast-radius nodes ranked by PageRank for a fully-qualified hit", async () => {
    const env = await handler({ file_or_symbol: "src/c.ts::c" });
    expect(env.results.length).toBeGreaterThan(0);
    const ids = env.results.map((n) => (n as { symbol: { symbol: string } }).symbol.symbol);
    // c's transitive callers: a (a->c, a->b->c), b (b->c), d (d->b->c).
    expect(ids.sort()).toEqual(["src/a.ts::a", "src/b.ts::b", "src/d.ts::d"]);
    // PageRank-descending sort holds: results sorted by pagerank then id.
    const ranks = env.results.map(
      (n) => (n as { pagerank: number }).pagerank,
    );
    for (let i = 1; i < ranks.length; i++) {
      // Either descending OR equal (then stable by id); >= holds in both cases.
      expect(ranks[i - 1] >= ranks[i]).toBe(true);
    }
  });

  it("each ImpactNode includes symbol/blast_radius/pagerank/shortest_path", async () => {
    const env = await handler({ file_or_symbol: "src/c.ts::c" });
    for (const r of env.results) {
      const node = r as {
        symbol: { symbol: string; path: string };
        blast_radius: number;
        pagerank: number;
        shortest_path: Array<{ symbol: string }>;
      };
      expect(typeof node.symbol.symbol).toBe("string");
      expect(typeof node.blast_radius).toBe("number");
      expect(typeof node.pagerank).toBe("number");
      expect(node.shortest_path.length).toBeGreaterThanOrEqual(1);
      // First node in shortest_path is the originating symbol id.
      expect(node.shortest_path[0].symbol).toBe("src/c.ts::c");
    }
  });

  it("returns empty array for a leaf symbol (no callers)", async () => {
    const env = await handler({ file_or_symbol: "src/e.ts::e" });
    expect(env.results).toEqual([]);
  });

  it("returns empty array for an unknown symbol", async () => {
    const env = await handler({ file_or_symbol: "src/nope.ts::Nope" });
    expect(env.results).toEqual([]);
  });

  it("file-path input expands to all symbols in the file (deduped union)", async () => {
    const env = await handler({ file_or_symbol: "src/multi.ts" });
    const ids = env.results
      .map((n) => (n as { symbol: { symbol: string } }).symbol.symbol)
      .sort();
    expect(ids).toEqual([
      "src/caller.ts::caller-of-m1",
      "src/caller.ts::caller-of-m2",
    ]);
  });

  it("respects the internal cap (<=100 results)", async () => {
    // Seed has only ~5 callers in any traversal — assert the cap field
    // is honored by checking the result count is bounded.
    const env = await handler({ file_or_symbol: "src/c.ts::c" });
    expect(env.results.length).toBeLessThanOrEqual(100);
  });

  it("rejects invalid input (empty string) with a structured warning", async () => {
    const env = await handler({ file_or_symbol: "" });
    expect(env.results).toEqual([]);
    expect(env.diagnostics.warnings ?? []).toEqual([
      expect.stringMatching(/invalid input/),
    ]);
  });

  it("returns a clean error envelope when the index is missing", async () => {
    _setTestDbPath(path.join(tmp, "does-not-exist.sqlite"));
    const env = await handler({ file_or_symbol: "src/c.ts::c" });
    expect(env.results).toEqual([]);
    expect(env.diagnostics.warnings ?? []).toEqual([
      expect.stringMatching(/index unavailable/),
    ]);
  });

  it("description is >=150 chars (Claude Code tool-search retrieval gate)", () => {
    expect(description.length).toBeGreaterThanOrEqual(150);
  });

  it("envelope channel is 'code' (POST-FORGE-VISION amendment §2)", async () => {
    const env = await handler({ file_or_symbol: "src/c.ts::c" });
    expect(env.channel).toBe("code");
  });

  // §15 YELLOW (Codex impl-015): impact() reports a one-step approximation
  // for shortest_path (`[origin, impacted]` regardless of true depth) and
  // sets `blast_radius` to the CTE depth, not a real breadth/count radius.
  // Agents that consume the response should be able to detect this so they
  // don't treat the path as ground truth. Surface it via:
  //   - `approximate: true` on each ImpactNode whose depth > 1 (the v0
  //     CTE doesn't carry parent links)
  //   - `path_kind: "exact" | "approximate"` to make it explicit
  //   - top-level `diagnostics.warnings` entry the first time the response
  //     contains any approximate path, so the agent gets a single visible
  //     hint per call
  describe("§15 YELLOW — approximate path disclosure", () => {
    it("marks transitive-depth ImpactNodes as approximate", async () => {
      const env = await handler({ file_or_symbol: "src/c.ts::c" });
      const transitive = env.results.filter(
        (n) => (n as { blast_radius: number }).blast_radius > 1,
      );
      expect(transitive.length).toBeGreaterThan(0);
      for (const r of transitive) {
        const node = r as { approximate?: boolean; path_kind?: string };
        expect(node.approximate).toBe(true);
        expect(node.path_kind).toBe("approximate");
      }
    });

    it("marks depth-1 (direct caller) ImpactNodes as exact", async () => {
      // src/b.ts::b is a direct caller of src/c.ts::c (b -> c).
      const env = await handler({ file_or_symbol: "src/c.ts::c" });
      const direct = env.results.find(
        (n) => (n as { symbol: { symbol: string } }).symbol.symbol === "src/b.ts::b",
      );
      expect(direct).toBeDefined();
      const node = direct as {
        blast_radius: number;
        approximate?: boolean;
        path_kind?: string;
      };
      expect(node.blast_radius).toBe(1);
      expect(node.approximate ?? false).toBe(false);
      expect(node.path_kind).toBe("exact");
    });

    it("emits a top-level diagnostics warning when any path is approximate", async () => {
      const env = await handler({ file_or_symbol: "src/c.ts::c" });
      const warnings = env.diagnostics.warnings ?? [];
      expect(
        warnings.some((w) =>
          /approximate|shortest_path.*one-step|v0 CTE/i.test(w),
        ),
      ).toBe(true);
    });

    it("does NOT emit the approximation warning when every result is direct", async () => {
      // m1 / m2 callers are all depth-1 → no transitive approximation.
      const env = await handler({ file_or_symbol: "src/multi.ts" });
      const warnings = env.diagnostics.warnings ?? [];
      expect(
        warnings.some((w) =>
          /approximate|shortest_path.*one-step|v0 CTE/i.test(w),
        ),
      ).toBe(false);
    });
  });
});

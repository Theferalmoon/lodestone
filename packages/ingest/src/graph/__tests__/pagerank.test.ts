// SPDX-License-Identifier: Apache-2.0
// PageRank tests — sum invariant, disconnected components, golden ranking,
// empty/single-node edge cases, no-mutation guarantee.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { Edge, LodestoneSymbol } from "@lodestone/shared";

import { buildGraph } from "../builder.js";
import { pageRank } from "../pagerank.js";
import { TINY_EDGES, TINY_SYMBOLS } from "../__fixtures__/tiny-fixture.js";
import { MINI_EDGES, MINI_SYMBOLS } from "../__fixtures__/mini-repo.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = path.join(HERE, "..", "__fixtures__", "golden-pagerank.json");

describe("pageRank", () => {
  it("returns scores summing to ~1.0 across all nodes", () => {
    const g = buildGraph({ symbols: TINY_SYMBOLS, edges: TINY_EDGES });
    const pr = pageRank(g);
    const sum = [...pr.values()].reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 3);
  });

  it("returns one entry per node", () => {
    const g = buildGraph({ symbols: TINY_SYMBOLS, edges: TINY_EDGES });
    const pr = pageRank(g);
    expect(pr.size).toBe(g.order);
    for (const node of g.nodes()) {
      expect(pr.has(node)).toBe(true);
    }
  });

  it("handles disconnected components without erroring", () => {
    // Two unconnected triangles.
    const sym = (file: string, name: string): LodestoneSymbol => ({
      symbol: `${file}::${name}`,
      path: file,
      range: { start_line: 1, end_line: 1 },
      language: "typescript",
      kind: "function",
    });
    const symbols = [
      sym("a.ts", "x1"),
      sym("a.ts", "x2"),
      sym("a.ts", "x3"),
      sym("b.ts", "y1"),
      sym("b.ts", "y2"),
      sym("b.ts", "y3"),
    ];
    const tri = (file: string, a: string, b: string): Edge => ({
      from: `${file}::${a}`,
      to: `${file}::${b}`,
      kind: "calls",
      weight: 1,
    });
    const edges = [
      tri("a.ts", "x1", "x2"),
      tri("a.ts", "x2", "x3"),
      tri("a.ts", "x3", "x1"),
      tri("b.ts", "y1", "y2"),
      tri("b.ts", "y2", "y3"),
      tri("b.ts", "y3", "y1"),
    ];
    const g = buildGraph({ symbols, edges });
    const pr = pageRank(g);
    expect(pr.size).toBe(6);
    // Symmetry: each triangle is identical, so corresponding nodes should
    // have equal PageRank within numerical drift.
    expect(pr.get("a.ts::x1")).toBeCloseTo(pr.get("b.ts::y1")!, 4);
  });

  it("returns an empty Map for an empty graph", () => {
    const g = buildGraph({ symbols: [], edges: [] });
    const pr = pageRank(g);
    expect(pr.size).toBe(0);
  });

  it("returns score 1.0 for a single-node graph", () => {
    const lone: LodestoneSymbol = {
      symbol: "lone.ts::x",
      path: "lone.ts",
      range: { start_line: 1, end_line: 1 },
      language: "typescript",
      kind: "function",
    };
    const g = buildGraph({ symbols: [lone], edges: [] });
    const pr = pageRank(g);
    expect(pr.size).toBe(1);
    expect(pr.get("lone.ts::x")).toBe(1);
  });

  it("does not mutate the input graph", () => {
    const g = buildGraph({ symbols: TINY_SYMBOLS, edges: TINY_EDGES });
    const beforeOrder = g.order;
    const beforeSize = g.size;
    const beforeNodeAttrs = g
      .nodes()
      .map((n) => [n, JSON.stringify(g.getNodeAttributes(n))] as const);
    const beforeEdgeAttrs = g
      .edges()
      .map((e) => [e, JSON.stringify(g.getEdgeAttributes(e))] as const);

    pageRank(g);
    pageRank(g, { alpha: 0.7 });
    pageRank(g, { getEdgeWeight: null });

    expect(g.order).toBe(beforeOrder);
    expect(g.size).toBe(beforeSize);
    for (const [n, before] of beforeNodeAttrs) {
      expect(JSON.stringify(g.getNodeAttributes(n))).toBe(before);
    }
    for (const [e, before] of beforeEdgeAttrs) {
      expect(JSON.stringify(g.getEdgeAttributes(e))).toBe(before);
    }
  });

  it("matches the recorded golden ranking on the mini-repo fixture", () => {
    const g = buildGraph({ symbols: MINI_SYMBOLS, edges: MINI_EDGES });
    const pr = pageRank(g);
    const ranking = [...pr.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([id, score]) => ({ id, score: Number(score.toFixed(8)) }));

    const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as {
      ranking: { id: string; score: number }[];
    };

    // Top-20 ids must match exactly.
    expect(ranking.slice(0, 20).map((e) => e.id)).toEqual(
      golden.ranking.slice(0, 20).map((e) => e.id),
    );
    // Per-node scores within tight tolerance — guards against algorithm drift.
    for (let i = 0; i < golden.ranking.length; i++) {
      const got = ranking[i]!;
      const expected = golden.ranking[i]!;
      expect(got.id).toBe(expected.id);
      expect(got.score).toBeCloseTo(expected.score, 6);
    }
  });

  it("is deterministic across successive runs on the tiny fixture", () => {
    const g = buildGraph({ symbols: TINY_SYMBOLS, edges: TINY_EDGES });
    const a = pageRank(g);
    const b = pageRank(g);
    expect([...a.entries()].sort()).toEqual([...b.entries()].sort());
  });

  it("respects a non-default alpha", () => {
    const g = buildGraph({ symbols: TINY_SYMBOLS, edges: TINY_EDGES });
    const lo = pageRank(g, { alpha: 0.5 });
    const hi = pageRank(g, { alpha: 0.95 });
    // Different alpha → different scores (sanity, not a precise property).
    expect(lo.get("src/auth.ts::hashCompare")).not.toBeCloseTo(
      hi.get("src/auth.ts::hashCompare")!,
      3,
    );
  });

  it("ignores edge weights when getEdgeWeight is null", () => {
    const sym = (name: string): LodestoneSymbol => ({
      symbol: `f.ts::${name}`,
      path: "f.ts",
      range: { start_line: 1, end_line: 1 },
      language: "typescript",
      kind: "function",
    });
    const symbols = [sym("a"), sym("b"), sym("c")];
    const edges: Edge[] = [
      { from: "f.ts::a", to: "f.ts::b", kind: "calls", weight: 100 },
      { from: "f.ts::a", to: "f.ts::c", kind: "calls", weight: 1 },
    ];
    const g = buildGraph({ symbols, edges });
    const weighted = pageRank(g);
    const uniform = pageRank(g, { getEdgeWeight: null });
    // Weighted: b ≫ c. Uniform: b ≈ c.
    expect(weighted.get("f.ts::b")).toBeGreaterThan(weighted.get("f.ts::c")!);
    expect(uniform.get("f.ts::b")).toBeCloseTo(uniform.get("f.ts::c")!, 6);
  });
});

// SPDX-License-Identifier: Apache-2.0
// Builder tests — node count, edge fidelity, stub-external behaviour, weight aggregation.

import { describe, expect, it } from "vitest";

import type { Edge, LodestoneSymbol } from "@lodestone/shared";

import { buildGraph } from "../builder.js";
import { TINY_EDGES, TINY_SYMBOLS } from "../__fixtures__/tiny-fixture.js";

describe("buildGraph", () => {
  it("produces one node per symbol plus stubs for unresolved edge targets", () => {
    const g = buildGraph({ symbols: TINY_SYMBOLS, edges: TINY_EDGES });
    // 5 real symbols + 1 external "lodash" stub
    expect(g.order).toBe(6);
    for (const sym of TINY_SYMBOLS) {
      expect(g.hasNode(sym.symbol)).toBe(true);
      expect(g.getNodeAttribute(sym.symbol, "external")).toBe(false);
      expect(g.getNodeAttribute(sym.symbol, "symbol")).toEqual(sym);
    }
  });

  it("attaches edges with correct kind/weight for the tiny fixture", () => {
    const g = buildGraph({ symbols: TINY_SYMBOLS, edges: TINY_EDGES });
    // 4 distinct (from, to, kind) triples in TINY_EDGES.
    expect(g.size).toBe(4);
    const loginEdges = g.outEdges("src/auth.ts::login").map((e) => ({
      target: g.target(e),
      ...g.getEdgeAttributes(e),
    }));
    expect(loginEdges).toEqual(
      expect.arrayContaining([
        { target: "src/auth.ts::verifyPassword", kind: "calls", weight: 1 },
        { target: "src/auth.ts::recordAttempt", kind: "calls", weight: 1 },
        { target: "lodash", kind: "imports", weight: 1 },
      ]),
    );
  });

  it("marks unresolved edge targets as external stub nodes", () => {
    const g = buildGraph({ symbols: TINY_SYMBOLS, edges: TINY_EDGES });
    expect(g.hasNode("lodash")).toBe(true);
    expect(g.getNodeAttribute("lodash", "external")).toBe(true);
    expect(g.getNodeAttribute("lodash", "symbol")).toBeNull();
  });

  it("aggregates weight when the same (from, to, kind) appears multiple times", () => {
    const sym = (name: string): LodestoneSymbol => ({
      symbol: `f.ts::${name}`,
      path: "f.ts",
      range: { start_line: 1, end_line: 1 },
      language: "typescript",
      kind: "function",
    });
    const symbols = [sym("a"), sym("b")];
    const edges: Edge[] = [
      { from: "f.ts::a", to: "f.ts::b", kind: "calls", weight: 1 },
      { from: "f.ts::a", to: "f.ts::b", kind: "calls", weight: 1 },
      { from: "f.ts::a", to: "f.ts::b", kind: "calls", weight: 3 },
    ];
    const g = buildGraph({ symbols, edges });
    expect(g.size).toBe(1);
    const attrs = g.getEdgeAttributes(g.edges()[0]!);
    expect(attrs.weight).toBe(5);
  });

  it("keeps different edge kinds between the same pair as separate edges", () => {
    const sym = (name: string): LodestoneSymbol => ({
      symbol: `f.ts::${name}`,
      path: "f.ts",
      range: { start_line: 1, end_line: 1 },
      language: "typescript",
      kind: "function",
    });
    const symbols = [sym("a"), sym("b")];
    const edges: Edge[] = [
      { from: "f.ts::a", to: "f.ts::b", kind: "calls", weight: 1 },
      { from: "f.ts::a", to: "f.ts::b", kind: "imports", weight: 1 },
    ];
    const g = buildGraph({ symbols, edges });
    expect(g.size).toBe(2);
  });

  it("stubs the source side too if an edge references an unknown source", () => {
    const sym = (name: string): LodestoneSymbol => ({
      symbol: `f.ts::${name}`,
      path: "f.ts",
      range: { start_line: 1, end_line: 1 },
      language: "typescript",
      kind: "function",
    });
    const symbols = [sym("b")];
    const edges: Edge[] = [
      { from: "ghost::x", to: "f.ts::b", kind: "calls", weight: 1 },
    ];
    const g = buildGraph({ symbols, edges });
    expect(g.hasNode("ghost::x")).toBe(true);
    expect(g.getNodeAttribute("ghost::x", "external")).toBe(true);
  });

  it("accepts self-loops (recursive functions)", () => {
    const sym = (name: string): LodestoneSymbol => ({
      symbol: `f.ts::${name}`,
      path: "f.ts",
      range: { start_line: 1, end_line: 1 },
      language: "typescript",
      kind: "function",
    });
    const symbols = [sym("rec")];
    const edges: Edge[] = [
      { from: "f.ts::rec", to: "f.ts::rec", kind: "calls", weight: 1 },
    ];
    const g = buildGraph({ symbols, edges });
    expect(g.size).toBe(1);
    expect(g.hasEdge("f.ts::rec", "f.ts::rec")).toBe(true);
  });

  it("returns an empty graph for empty input", () => {
    const g = buildGraph({ symbols: [], edges: [] });
    expect(g.order).toBe(0);
    expect(g.size).toBe(0);
  });
});

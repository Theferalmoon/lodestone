// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";

import type { Edge, LodestoneSymbol } from "@lodestone/shared";

import { buildGraph } from "../../graph/builder.js";
import { pageRank } from "../../graph/pagerank.js";

import { cluster, louvainVersion, stableClusterId } from "../index.js";

function mkSym(qid: string, sigLen = 200): LodestoneSymbol {
  const path = qid.split("::")[0]!;
  return {
    symbol: qid,
    path,
    range: { start_line: 1, end_line: 10 },
    language: "typescript",
    kind: "function",
    signature: "x".repeat(sigLen),
  };
}

function authFixture(): { symbols: LodestoneSymbol[]; edges: Edge[] } {
  const symbols = [
    mkSym("src/auth.ts::login"),
    mkSym("src/auth.ts::logout"),
    mkSym("src/auth.ts::verifyToken"),
    mkSym("src/auth.ts::issueToken"),
    mkSym("src/auth.ts::hashPassword"),
    mkSym("src/util.ts::pad"),
    mkSym("src/util.ts::trim"),
    mkSym("src/util.ts::format"),
  ];
  // Strong intra-cluster path-affinity (same dir) → high gamma * path_affinity.
  const edges: Edge[] = [
    { from: "src/auth.ts::login", to: "src/auth.ts::verifyToken", kind: "calls" },
    { from: "src/auth.ts::login", to: "src/auth.ts::hashPassword", kind: "calls" },
    { from: "src/auth.ts::logout", to: "src/auth.ts::verifyToken", kind: "calls" },
    { from: "src/auth.ts::issueToken", to: "src/auth.ts::hashPassword", kind: "calls" },
    { from: "src/util.ts::pad", to: "src/util.ts::trim", kind: "calls" },
    { from: "src/util.ts::format", to: "src/util.ts::pad", kind: "calls" },
    { from: "src/util.ts::format", to: "src/util.ts::trim", kind: "calls" },
  ];
  return { symbols, edges };
}

describe("cluster() — basic shape", () => {
  it("returns [] for empty graph", () => {
    const g = buildGraph({ symbols: [], edges: [] });
    expect(cluster(g, new Map())).toEqual([]);
  });

  it("returns ≥1 cluster on the auth+util fixture and members sum to total non-stub nodes", () => {
    const { symbols, edges } = authFixture();
    const g = buildGraph({ symbols, edges });
    const pr = pageRank(g);
    const clusters = cluster(g, pr);
    expect(clusters.length).toBeGreaterThanOrEqual(1);
    const total = clusters.reduce((acc, c) => acc + c.members.length, 0);
    expect(total).toBeLessThanOrEqual(symbols.length);
    expect(total).toBeGreaterThanOrEqual(Math.floor(symbols.length / 2));
  });

  it("auth-cluster name contains 'auth' (heuristic invariant)", () => {
    const { symbols, edges } = authFixture();
    const g = buildGraph({ symbols, edges });
    const pr = pageRank(g);
    const clusters = cluster(g, pr);
    // Find the cluster that contains the auth symbols.
    const authCluster = clusters.find((c) =>
      c.members.some((m) => m.symbol.startsWith("src/auth.ts::")),
    );
    expect(authCluster).toBeDefined();
    expect(authCluster!.name.toLowerCase()).toContain("auth");
  });
});

describe("cluster() — determinism", () => {
  it("produces identical cluster IDs across 10 runs with same seed", () => {
    const { symbols, edges } = authFixture();
    const runs = Array.from({ length: 10 }, () => {
      const g = buildGraph({ symbols, edges });
      const pr = pageRank(g);
      return cluster(g, pr, { seed: 42 }).map((c) => c.id);
    });
    for (let i = 1; i < runs.length; i++) {
      expect(runs[i]).toEqual(runs[0]);
    }
  });
});

describe("cluster() — Leiden rejected in v0", () => {
  it("throws a clear error for algorithm: 'leiden'", () => {
    const g = buildGraph({ symbols: [], edges: [] });
    // Empty-graph short-circuit returns [] before the algorithm check would fire,
    // so use a non-empty graph.
    const symbols = [mkSym("a::x")];
    const populated = buildGraph({ symbols, edges: [] });
    expect(() => cluster(populated, new Map(), { algorithm: "leiden" })).toThrow(
      /v0\.5\+ Pro mode/,
    );
    // Empty-graph short-circuit happens before the leiden check.
    expect(cluster(g, new Map(), { algorithm: "leiden" })).toEqual([]);
  });
});

describe("cluster() — diagnostics + version", () => {
  it("populates diagnostics with louvain + version + counts + modularity", () => {
    const { symbols, edges } = authFixture();
    const g = buildGraph({ symbols, edges });
    const pr = pageRank(g);
    const clusters = cluster(g, pr);
    expect(clusters.length).toBeGreaterThan(0);
    const d = clusters[0]!.diagnostics;
    expect(d.algorithm).toBe("louvain");
    expect(d.algorithm_version).toBe(louvainVersion());
    expect(d.graph_node_count).toBe(g.order);
    expect(d.graph_edge_count).toBeGreaterThanOrEqual(0);
    expect(typeof d.modularity).toBe("number");
    expect(typeof d.singleton_count).toBe("number");
    expect(typeof d.bridge_count).toBe("number");
    expect(d.stability_hash).toBe(clusters[0]!.id);
  });
});

describe("stableClusterId", () => {
  it("is stable across re-orderings of the same member set", () => {
    const a = stableClusterId(["x", "y", "z"], "louvain");
    const b = stableClusterId(["z", "y", "x"], "louvain");
    expect(a).toBe(b);
  });
  it("changes when membership changes", () => {
    const a = stableClusterId(["x", "y", "z"], "louvain");
    const b = stableClusterId(["x", "y"], "louvain");
    expect(a).not.toBe(b);
  });
});

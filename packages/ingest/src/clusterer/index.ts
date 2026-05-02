// SPDX-License-Identifier: Apache-2.0
// Public entry: cluster() runs the full Louvain → name → penalize → assemble
// pipeline against a LodestoneGraph and returns Cluster[] ready to persist.

import { createHash } from "node:crypto";

import type { Cluster, LodestoneSymbol, SymbolRef } from "@lodestone/shared";

import type { LodestoneGraph } from "../graph/builder.js";

import { runLouvain, louvainVersion } from "./louvain.js";
import { composeName } from "./naming.js";
import {
  applyShortContentPenalty,
  buildPenaltyMembers,
} from "./short-content.js";
import { applyWeighting, DEFAULT_WEIGHTING } from "./weighting.js";

export interface ClusterOptions {
  algorithm?: "louvain" | "leiden";
  resolution?: number;
  alpha?: number;
  beta?: number;
  gamma?: number;
  minWeight?: number;
  seed?: number;
  /** Cap on bridges surfaced per cluster. Default 10. */
  maxBridges?: number;
}

/**
 * Run Louvain over the call graph and return named, content-penalized clusters.
 *
 * `pagerank` is the Map returned by §07's `pageRank()` — passed in rather than
 * read from graph attributes because §07's pageRank doesn't write back to the
 * graph (it returns a Map). Empty Map is fine; missing entries default to 0.
 *
 * Empty graph -> []. Deterministic given the same `seed`.
 *
 * NOTE: this MUTATES the input graph (applies edge weights, drops low-weight
 * edges). Callers that need to preserve the original graph should clone first.
 */
export function cluster(
  graph: LodestoneGraph,
  pagerank: ReadonlyMap<string, number>,
  opts: ClusterOptions = {},
): Cluster[] {
  // Empty-graph short-circuit BEFORE the algorithm check — empty graph is a
  // valid no-op regardless of which algorithm was requested.
  if (graph.order === 0) return [];
  const algorithm = opts.algorithm ?? "louvain";
  if (algorithm === "leiden") {
    throw new Error("Leiden requires v0.5+ Pro mode (Lodestone v0 ships Louvain only)");
  }

  const seed = opts.seed ?? 42;
  const resolution = opts.resolution ?? 1.5;
  const maxBridges = opts.maxBridges ?? 10;

  // 1. Edge weighting + low-weight pruning.
  applyWeighting(graph, {
    alpha: opts.alpha ?? DEFAULT_WEIGHTING.alpha,
    beta: opts.beta ?? DEFAULT_WEIGHTING.beta,
    gamma: opts.gamma ?? DEFAULT_WEIGHTING.gamma,
    minWeight: opts.minWeight ?? DEFAULT_WEIGHTING.minWeight,
  });

  // 2. Louvain.
  const louvainResult = runLouvain(graph, {
    resolution,
    seed,
    getEdgeWeight: "weight",
  });

  // 3. Bucket nodes by community.
  const buckets = new Map<number, string[]>();
  for (const [node, community] of Object.entries(louvainResult.assignments)) {
    const list = buckets.get(community);
    if (list) list.push(node);
    else buckets.set(community, [node]);
  }

  // 4. Build cluster objects.
  const out: Cluster[] = [];
  let singletons = 0;
  let totalBridges = 0;
  for (const [, nodeIds] of buckets) {
    if (nodeIds.length === 1) singletons++;

    // Order by descending PageRank for naming + bridge ranking.
    const ranked = [...nodeIds].sort(
      (a, b) => (pagerank.get(b) ?? 0) - (pagerank.get(a) ?? 0),
    );

    // Short-content penalty.
    const filtered = applyShortContentPenalty(
      buildPenaltyMembers(graph, ranked, pagerank),
    );
    if (filtered.length === 0) continue;

    const anchor = filtered[0]!;
    const { name, evidence } = composeName({ anchor, members: filtered });

    // Bridges = members with at least one out-edge into a different community.
    const myCommunity = louvainResult.assignments[anchor];
    const bridgeSet = new Set<string>();
    for (const m of filtered) {
      let isBridge = false;
      graph.forEachOutNeighbor(m, (neighbor) => {
        if (louvainResult.assignments[neighbor] !== myCommunity) {
          isBridge = true;
        }
      });
      if (isBridge) bridgeSet.add(m);
    }
    const bridges: SymbolRef[] = [...bridgeSet]
      .sort((a, b) => (pagerank.get(b) ?? 0) - (pagerank.get(a) ?? 0))
      .slice(0, maxBridges)
      .map((sym) => toRef(graph, sym, pagerank));
    totalBridges += bridges.length;

    const members: SymbolRef[] = filtered.map((sym) => toRef(graph, sym, pagerank));
    const id = stableClusterId(filtered, "louvain");

    out.push({
      id,
      name,
      name_status: "heuristic",
      agent_instruction: "synthesize_name_from_members",
      naming_evidence: evidence,
      description: shortDescription(name, members.length, evidence.dominant_verb),
      size: members.length,
      members,
      bridges,
      diagnostics: {
        algorithm: "louvain",
        algorithm_version: louvainVersion(),
        resolution,
        seed,
        graph_node_count: graph.order,
        graph_edge_count: graph.size,
        modularity: louvainResult.modularity,
        singleton_count: singletons,
        bridge_count: totalBridges,
        stability_hash: id,
      },
    });
  }
  // Sort by size desc for deterministic test output.
  out.sort((a, b) => b.size - a.size || a.id.localeCompare(b.id));
  return out;
}

function toRef(
  graph: LodestoneGraph,
  sym: string,
  pagerank: ReadonlyMap<string, number>,
): SymbolRef {
  const lsym = graph.getNodeAttribute(sym, "symbol") as LodestoneSymbol | null;
  const path = lsym?.path ?? "";
  const startLine = lsym?.range.start_line ?? 1;
  const endLine = lsym?.range.end_line ?? 1;
  return {
    symbol: sym,
    path,
    range: { start_line: startLine, end_line: endLine },
    pagerank: pagerank.get(sym) ?? 0,
  };
}

/** SHA256 truncated to 16 hex of sorted members + algorithm. Same membership -> same id. */
export function stableClusterId(members: readonly string[], algorithm: string): string {
  const sorted = [...members].sort();
  const h = createHash("sha256");
  h.update(algorithm);
  h.update("|");
  for (const m of sorted) {
    h.update(m);
    h.update("\n");
  }
  return h.digest("hex").slice(0, 16);
}

function shortDescription(name: string, size: number, verb?: string): string {
  if (verb) return `Cluster of ${size} symbols around the verb "${verb}" (heuristic name: ${name}).`;
  return `Cluster of ${size} symbols (heuristic name: ${name}).`;
}

export { runLouvain, louvainVersion } from "./louvain.js";
export { composeName, dominantVerb, dominantBasename } from "./naming.js";
export { applyShortContentPenalty, SHORT_THRESHOLD, MIN_SIZE } from "./short-content.js";
export { applyWeighting, fusedWeight, DEFAULT_WEIGHTING } from "./weighting.js";
export { persistClusters } from "./persist.js";

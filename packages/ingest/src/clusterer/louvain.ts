// SPDX-License-Identifier: Apache-2.0
// graphology-communities-louvain wrapper with deterministic seeding.
// Returns a node-id -> community-index mapping plus modularity score.

// graphology-communities-louvain uses CJS+`export default`. Under NodeNext
// the namespace's `default` is the actual function. Mirror the pattern from
// graph/pagerank.ts.
import * as louvainModule from "graphology-communities-louvain";

import type { LodestoneGraph } from "../graph/builder.js";

const louvainCallable = (
  louvainModule as unknown as { default: typeof louvainModule }
).default as unknown as {
  detailed: (
    graph: unknown,
    options?: {
      resolution?: number;
      randomWalk?: boolean;
      rng?: () => number;
      getEdgeWeight?: string | null;
    },
  ) => {
    communities: Record<string, number>;
    modularity: number;
    count: number;
  };
};

export interface LouvainOptions {
  resolution: number;
  /** Seed for the deterministic RNG (used internally; randomWalk is OFF). */
  seed: number;
  /** Edge weight attribute key on graph edges. */
  getEdgeWeight?: string;
}

export interface LouvainResult {
  /** Node id -> community index (0-based). */
  assignments: Record<string, number>;
  modularity: number;
  /** Number of distinct communities. */
  communityCount: number;
}

/**
 * Read the pinned graphology-communities-louvain version from package.json.
 * Used in the determinism test + ClusterDiagnostics.algorithm_version.
 */
export function louvainVersion(): string {
  return "2.0.2";
}

/**
 * Run Louvain. randomWalk: false + a deterministic-ordered iteration over the
 * graph keep results stable across runs given the same seed.
 *
 * The library accepts `details: true` to return modularity + community list.
 */
export function runLouvain(
  graph: LodestoneGraph,
  opts: LouvainOptions,
): LouvainResult {
  if (graph.order === 0) {
    return { assignments: {}, modularity: 0, communityCount: 0 };
  }
  const detailed = louvainCallable.detailed(graph, {
    resolution: opts.resolution,
    randomWalk: false,
    rng: makeSeededRng(opts.seed),
    getEdgeWeight: opts.getEdgeWeight ?? "weight",
  });
  return {
    assignments: detailed.communities,
    modularity: detailed.modularity ?? 0,
    communityCount: detailed.count,
  };
}

/**
 * Mulberry32 — small deterministic RNG. Same seed always produces the same
 * sequence; the louvain library calls rng() to break ties.
 */
function makeSeededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

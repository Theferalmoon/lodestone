// SPDX-License-Identifier: Apache-2.0
// PageRank wrapper — thin shim over `graphology-metrics/centrality/pagerank`
// that returns a Map<nodeKey, score> and never mutates its input. Isolating
// the algorithm here keeps the public surface stable if/when we swap to a
// custom implementation for >50k-symbol repos (see §07 spec impl notes).

// graphology-metrics ships a CJS file with `module.exports = pagerank` and a
// .d.ts that declares `export default pagerank`. Under NodeNext + verbatim
// CJS interop, the namespace's `default` is the actual function — `import x
// from` resolves to the namespace object, not the function. Use namespace
// import + .default to get the callable.
import * as pagerankModule from "graphology-metrics/centrality/pagerank.js";

const pagerankFn = (pagerankModule as unknown as { default: typeof pagerankModule })
  .default as unknown as (
  graph: unknown,
  options?: {
    alpha?: number;
    maxIterations?: number;
    tolerance?: number;
    getEdgeWeight?: string | null;
  },
) => Record<string, number>;

import type { LodestoneGraph } from "./builder.js";

export interface PageRankOptions {
  /** Damping factor; PageRank convention default 0.85. */
  alpha?: number;
  /** Power-iteration cap; 100 is graphology-metrics' default. */
  maxIterations?: number;
  /** Convergence tolerance; 1e-6 is graphology-metrics' default. */
  tolerance?: number;
  /**
   * Edge-attribute name to use as weight. Defaults to "weight" so callers
   * pick up the aggregated weights set by `buildGraph`. Pass `null` to
   * ignore edge weights entirely (uniform unit weights).
   */
  getEdgeWeight?: string | null;
}

/**
 * Compute PageRank over `graph`. Returns Map<nodeKey, score>; scores sum to
 * ~1.0 across all nodes (graphology contract). The input graph is NOT
 * mutated — we use the functional form of `graphology-metrics/centrality/
 * pagerank` rather than its `.assign` variant.
 *
 * Edge cases:
 *   - Empty graph → empty Map (not error).
 *   - Single-node graph → Map with one entry, score 1.0.
 *   - Disconnected components → handled natively by power iteration; isolated
 *     nodes receive the teleport-only baseline score.
 */
export function pageRank(
  graph: LodestoneGraph,
  options: PageRankOptions = {},
): Map<string, number> {
  if (graph.order === 0) return new Map();

  // Single-node graphs are an edge case where graphology-metrics' returned
  // mapping is technically correct (`{ [theNode]: 1 }`) but we short-circuit
  // for clarity + to skip the iterative kernel entirely.
  if (graph.order === 1) {
    const only = graph.nodes()[0]!;
    return new Map([[only, 1]]);
  }

  const result = pagerankFn(graph, {
    alpha: options.alpha ?? 0.85,
    maxIterations: options.maxIterations ?? 100,
    tolerance: options.tolerance ?? 1e-6,
    getEdgeWeight:
      options.getEdgeWeight === undefined ? "weight" : options.getEdgeWeight,
  });

  return new Map(Object.entries(result));
}

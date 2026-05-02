// SPDX-License-Identifier: Apache-2.0
// Pre-Louvain edge weighting + low-weight pruning. Fuses structural edges with
// configurable alpha/beta/gamma. v0 degrades gracefully:
//   - cosine_sim is always 0 because §07's graph does not yet store embeddings
//     on nodes (slated for future enhancement; §08 vec0 table is the storage).
//   - temporal is always 0 because §07's graph does not yet carry last_modified
//     timestamps on nodes (will land via §12 watcher integration).
//   - gamma * path_affinity is therefore the floor signal that always works.
// Once embeddings + timestamps are wired through, this module needs no API change.

import type { LodestoneSymbol } from "@lodestone/shared";

import type { LodestoneGraph } from "../graph/builder.js";

export interface WeightingOptions {
  alpha: number;
  beta: number;
  gamma: number;
  minWeight: number;
}

export const DEFAULT_WEIGHTING: WeightingOptions = {
  alpha: 0.4,
  beta: 0.05,
  gamma: 0.4,
  minWeight: 0.3,
};

/** Path affinity: longest common path-prefix divided by longer path's segment count. */
export function pathAffinity(srcPath: string, dstPath: string): number {
  const a = srcPath.split("/");
  const b = dstPath.split("/");
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 0;
  let common = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] === b[i]) common++;
    else break;
  }
  return common / maxLen;
}

/** Cosine similarity between two Float32Array vectors of equal length. Returns 0 if either is missing. */
export function cosineSim(
  a: Float32Array | undefined,
  b: Float32Array | undefined,
): number {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const va = a[i]!;
    const vb = b[i]!;
    dot += va * vb;
    na += va * va;
    nb += vb * vb;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Temporal proximity: 1 / (1 + days_apart). Returns 0 if either timestamp missing. */
export function temporalProximity(
  srcMs: number | undefined,
  dstMs: number | undefined,
): number {
  if (srcMs === undefined || dstMs === undefined) return 0;
  const daysApart = Math.abs(srcMs - dstMs) / 86_400_000;
  return 1 / (1 + daysApart);
}

/** Pull the LodestoneSymbol out of the node attribute. Falls back to null for stub external nodes. */
function symbolAt(graph: LodestoneGraph, node: string): LodestoneSymbol | null {
  return graph.getNodeAttribute(node, "symbol");
}

/**
 * Compute fused weight for one (src,dst) pair given the configured alphas.
 * v0: cosine_sim and temporal contribute 0 (data not on graph yet).
 */
export function fusedWeight(
  graph: LodestoneGraph,
  src: string,
  dst: string,
  opts: WeightingOptions,
): number {
  const srcSym = symbolAt(graph, src);
  const dstSym = symbolAt(graph, dst);
  const srcPath = srcSym?.path ?? src;
  const dstPath = dstSym?.path ?? dst;
  return (
    opts.alpha * cosineSim(undefined, undefined) +
    opts.beta * temporalProximity(undefined, undefined) +
    opts.gamma * pathAffinity(srcPath, dstPath)
  );
}

/**
 * Apply fused weight to every edge as a `weight` attribute, then drop edges
 * below opts.minWeight. Mutates the input graph; callers may want to clone first.
 */
export function applyWeighting(
  graph: LodestoneGraph,
  opts: WeightingOptions = DEFAULT_WEIGHTING,
): { keptEdges: number; droppedEdges: number } {
  let kept = 0;
  let dropped = 0;
  const toDrop: string[] = [];
  graph.forEachEdge((edge, _attrs, src, dst) => {
    const w = fusedWeight(graph, src, dst, opts);
    if (w < opts.minWeight) {
      toDrop.push(edge);
      dropped++;
    } else {
      graph.setEdgeAttribute(edge, "weight", w);
      kept++;
    }
  });
  for (const e of toDrop) graph.dropEdge(e);
  return { keptEdges: kept, droppedEdges: dropped };
}

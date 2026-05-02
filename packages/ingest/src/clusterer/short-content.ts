// SPDX-License-Identifier: Apache-2.0
// P4.5 short-content penalty (port from cmndi-clusterer commit 68889ab7).
// When >50% of a cluster's members have signature.length < SHORT_THRESHOLD,
// prune lowest-PageRank short-content members until the fraction <= 0.5
// OR the cluster falls below MIN_SIZE (3) at which point it dies naturally.

import type { LodestoneSymbol } from "@lodestone/shared";

import type { LodestoneGraph } from "../graph/builder.js";

export const SHORT_THRESHOLD = 100;
export const MIN_SIZE = 3;
export const MAX_SHORT_FRACTION = 0.5;

/** A member candidate with the data the penalty needs. */
export interface ShortPenaltyMember {
  symbol: string;
  signatureLength: number;
  pagerank: number;
}

/**
 * Apply the short-content penalty to a member set.
 * Returns the filtered list of symbol ids ordered by descending PageRank
 * (matching the original list's ordering for non-pruned members).
 */
export function applyShortContentPenalty(
  members: readonly ShortPenaltyMember[],
): readonly string[] {
  let working: ShortPenaltyMember[] = [...members];
  while (true) {
    const shortMembers = working.filter((m) => m.signatureLength < SHORT_THRESHOLD);
    const fraction = shortMembers.length / Math.max(working.length, 1);
    if (fraction <= MAX_SHORT_FRACTION) return working.map((m) => m.symbol);
    if (working.length <= MIN_SIZE) return working.map((m) => m.symbol);
    // Prune the lowest-PageRank short member.
    let lowestIdx = -1;
    let lowestPr = Infinity;
    for (let i = 0; i < working.length; i++) {
      const m = working[i]!;
      if (m.signatureLength >= SHORT_THRESHOLD) continue;
      if (m.pagerank < lowestPr) {
        lowestPr = m.pagerank;
        lowestIdx = i;
      }
    }
    if (lowestIdx < 0) return working.map((m) => m.symbol);
    working = working.filter((_, i) => i !== lowestIdx);
  }
}

/** Convenience: read signature from the LodestoneSymbol attribute, pagerank from caller's Map. */
export function buildPenaltyMembers(
  graph: LodestoneGraph,
  symbolIds: readonly string[],
  pagerank: ReadonlyMap<string, number>,
): ShortPenaltyMember[] {
  return symbolIds.map((sym) => {
    const lsym = graph.getNodeAttribute(sym, "symbol") as LodestoneSymbol | null;
    const sig = lsym?.signature ?? "";
    const pr = pagerank.get(sym) ?? 0;
    return { symbol: sym, signatureLength: sig.length, pagerank: pr };
  });
}

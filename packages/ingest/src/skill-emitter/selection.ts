// SPDX-License-Identifier: Apache-2.0
// Lodestone — emit-gating heuristics for cluster -> SKILL.md.

import type { Cluster } from "@lodestone/shared";

export interface SelectionConfig {
  /** Minimum cluster size; default 3. */
  minSize?: number;
  /** Maximum cluster size; default 50. */
  maxSize?: number;
  /** Minimum cluster age in days; default 2. */
  minAgeDays?: number;
}

export interface SelectionDecision {
  emit: boolean;
  reason?: "too_small" | "too_large" | "too_young" | "orphan_filter";
}

const DEFAULT_MIN_SIZE = 3;
const DEFAULT_MAX_SIZE = 50;
const DEFAULT_MIN_AGE_DAYS = 2;

export interface SelectionInputs {
  /** Days observed since the cluster first appeared. Use 0 for unknown. */
  observedDays: number;
}

/**
 * Decide whether a cluster is mature enough to deserve a SKILL.md card.
 *
 * Returns `{ emit: true }` on accept; `{ emit: false, reason }` on reject.
 *
 * Rejection reasons:
 *   - `too_small` — cluster size below `minSize`
 *   - `too_large` — cluster size above `maxSize`
 *   - `too_young` — observed less than `minAgeDays`
 *   - `orphan_filter` — every member of the cluster is a bridge (i.e. all
 *     edges leave the cluster), indicating generated code or a dead island.
 */
export function shouldEmit(
  cluster: Cluster,
  inputs: SelectionInputs,
  cfg: SelectionConfig = {},
): SelectionDecision {
  const minSize = cfg.minSize ?? DEFAULT_MIN_SIZE;
  const maxSize = cfg.maxSize ?? DEFAULT_MAX_SIZE;
  const minAgeDays = cfg.minAgeDays ?? DEFAULT_MIN_AGE_DAYS;

  if (cluster.size < minSize) return { emit: false, reason: "too_small" };
  if (cluster.size > maxSize) return { emit: false, reason: "too_large" };
  if (inputs.observedDays < minAgeDays) {
    return { emit: false, reason: "too_young" };
  }

  // Orphan filter: every member is a bridge → no internal cohesion at all.
  if (cluster.size > 0 && cluster.bridges.length === cluster.size) {
    return { emit: false, reason: "orphan_filter" };
  }

  return { emit: true };
}

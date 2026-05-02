// SPDX-License-Identifier: Apache-2.0
// Lodestone — confidence calculation for skill cards.

import type { Cluster } from "@lodestone/shared";

export interface ConfidenceInputs {
  /** Cluster size (member count). */
  size: number;
  /** Days observed since the cluster first appeared. */
  observedDays: number;
  /** Bridge count (cross-cluster connector members). */
  bridgeCount: number;
  /** Modularity from Louvain diagnostics (−1..1). */
  modularity: number;
}

/**
 * Combine the three signals available at emit time into a 0..1 confidence:
 *
 *   confidence = clamp(
 *     base
 *       + size_weight   * sizeFactor       (size capped at 10)
 *       + age_weight    * ageFactor        (age capped at 30 days)
 *       + cohesion_weight * cohesionFactor (modularity normalized)
 *       - bridge_penalty * bridgeFactor,
 *     0, 1
 *   )
 *
 * Weights are tuned so a brand-new 3-symbol cluster lands ~0.35 (low,
 * shows up but flagged as noisy) and a 30-day, 10+ member, well-modular
 * cluster lands ~0.95.
 */
export function computeConfidence(inputs: ConfidenceInputs): number {
  const sizeFactor = Math.min(inputs.size / 10, 1);
  const ageFactor = Math.min(Math.max(inputs.observedDays, 0) / 30, 1);
  // Modularity ranges roughly 0..1 in practice; clamp to be safe.
  const cohesionFactor = Math.min(Math.max(inputs.modularity, 0), 1);
  // Bridge penalty: a cluster where >50% of members are bridges is suspect.
  const bridgeRatio = inputs.size > 0 ? inputs.bridgeCount / inputs.size : 0;
  const bridgeFactor = Math.min(bridgeRatio, 1);

  const raw =
    0.2 +
    0.3 * sizeFactor +
    0.3 * ageFactor +
    0.25 * cohesionFactor -
    0.15 * bridgeFactor;
  return Math.min(Math.max(raw, 0), 1);
}

/**
 * Compute observed_days from a cluster's `created_at` ISO string. Falls back
 * to 0 if the cluster does not carry a created_at (deterministic seeds, or
 * test fixtures without one). The §09 `Cluster` shape does not yet carry
 * `created_at` directly, so the caller passes it explicitly.
 */
export function observedDaysFrom(createdAt: string | undefined, now: Date): number {
  if (!createdAt) return 0;
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) return 0;
  const diffMs = now.getTime() - t;
  return Math.max(0, Math.floor(diffMs / (24 * 60 * 60 * 1000)));
}

/**
 * Confidence inputs derived from a §09 Cluster and an observedDays value.
 * Keeps the formula testable in isolation from the cluster fixture shape.
 */
export function confidenceInputsFromCluster(
  cluster: Cluster,
  observedDays: number,
): ConfidenceInputs {
  return {
    size: cluster.size,
    observedDays,
    bridgeCount: cluster.bridges.length,
    modularity: cluster.diagnostics.modularity ?? 0,
  };
}

// SPDX-License-Identifier: Apache-2.0
// max_response_kb truncation guard. JSON-serializes the envelope, drops tail
// `results[]` until the budget is met, then sets `truncated: true` and adds a
// warning. Never touches `provenance` or `diagnostics` — those are load-bearing
// for the agent.

import type { Diagnostics } from "@lodestone/shared";

import type { LodestoneToolResponseV13 } from "./envelope.js";

const TRUNCATION_WARNING_PREFIX = "response truncated to fit max_response_kb=";

/**
 * Returns the byte length of `JSON.stringify(envelope)`. Public for tests; the
 * production path inlines the cheap UTF-8 byte estimate.
 */
export function envelopeByteLength<T>(envelope: LodestoneToolResponseV13<T>): number {
  return Buffer.byteLength(JSON.stringify(envelope), "utf8");
}

/**
 * Enforce the response-size budget. If the serialized envelope is within
 * `maxKb` (KB), returned unchanged. Otherwise, drop tail `results[]` entries
 * until it fits or the array is empty, then set `truncated: true` and add a
 * warning string to `diagnostics.warnings`.
 *
 * Algorithm note: O(n) shrink with a per-iteration JSON.stringify is fine for
 * the typical case (response oversized by a small factor) and dramatically
 * simpler than tracking per-element byte costs. Tools whose payloads are
 * pathologically large (>10x budget) should clamp `top_k` upstream — the §13
 * tool input schemas already do.
 */
export function enforceMaxResponseKb<T>(
  envelope: LodestoneToolResponseV13<T>,
  maxKb: number,
): LodestoneToolResponseV13<T> {
  if (!Number.isInteger(maxKb) || maxKb < 1) {
    throw new Error(`enforceMaxResponseKb: maxKb must be positive integer; got ${maxKb}`);
  }
  const budgetBytes = maxKb * 1024;
  if (envelopeByteLength(envelope) <= budgetBytes) {
    return envelope;
  }

  // Work on a shallow clone so the caller's reference isn't mutated.
  const truncated: LodestoneToolResponseV13<T> = {
    ...envelope,
    results: [...envelope.results],
    diagnostics: cloneDiagnostics(envelope.diagnostics),
  };

  while (truncated.results.length > 0 && envelopeByteLength(truncated) > budgetBytes) {
    truncated.results.pop();
  }

  truncated.truncated = true;
  truncated.diagnostics = withTruncationWarning(truncated.diagnostics, maxKb);
  return truncated;
}

function cloneDiagnostics(d: Diagnostics): Diagnostics {
  return {
    ...d,
    warnings: d.warnings ? [...d.warnings] : undefined,
  };
}

function withTruncationWarning(d: Diagnostics, maxKb: number): Diagnostics {
  const warning = `${TRUNCATION_WARNING_PREFIX}${maxKb}`;
  const warnings = d.warnings ? [...d.warnings, warning] : [warning];
  return { ...d, warnings, truncated: true };
}

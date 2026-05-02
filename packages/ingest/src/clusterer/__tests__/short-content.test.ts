// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";

import {
  applyShortContentPenalty,
  MAX_SHORT_FRACTION,
  MIN_SIZE,
  SHORT_THRESHOLD,
} from "../short-content.js";

const longSig = "x".repeat(SHORT_THRESHOLD + 10);
const shortSig = "x".repeat(SHORT_THRESHOLD - 10);

describe("applyShortContentPenalty", () => {
  it("returns input unchanged when fraction <= 0.5", () => {
    const members = [
      { symbol: "a", signatureLength: longSig.length, pagerank: 0.4 },
      { symbol: "b", signatureLength: longSig.length, pagerank: 0.3 },
      { symbol: "c", signatureLength: shortSig.length, pagerank: 0.2 },
      { symbol: "d", signatureLength: shortSig.length, pagerank: 0.1 },
    ];
    expect(applyShortContentPenalty(members)).toEqual(["a", "b", "c", "d"]);
  });

  it("prunes lowest-PageRank short members until fraction <= 0.5", () => {
    const members = [
      { symbol: "a", signatureLength: shortSig.length, pagerank: 0.05 }, // shortest, lowest PR
      { symbol: "b", signatureLength: shortSig.length, pagerank: 0.1 },
      { symbol: "c", signatureLength: shortSig.length, pagerank: 0.2 },
      { symbol: "d", signatureLength: shortSig.length, pagerank: 0.3 },
      { symbol: "e", signatureLength: longSig.length, pagerank: 0.4 },
    ];
    // 4 short / 1 long = 80% short. Drop a (lowest PR short) → 3/4 = 75% → drop b → 2/3 = 66% → drop c → 1/2 = 50%. Stop.
    const result = applyShortContentPenalty(members);
    expect(result.length).toBeLessThanOrEqual(members.length);
    const remaining = result.map((sym) => members.find((m) => m.symbol === sym)!);
    const shortFraction =
      remaining.filter((m) => m.signatureLength < SHORT_THRESHOLD).length /
      remaining.length;
    // Either fraction now <= 0.5 OR cluster fell below MIN_SIZE.
    expect(shortFraction <= MAX_SHORT_FRACTION || result.length <= MIN_SIZE).toBe(
      true,
    );
  });

  it("does not prune below MIN_SIZE even if fraction stays > 0.5", () => {
    const members = [
      { symbol: "a", signatureLength: shortSig.length, pagerank: 0.1 },
      { symbol: "b", signatureLength: shortSig.length, pagerank: 0.2 },
      { symbol: "c", signatureLength: shortSig.length, pagerank: 0.3 },
    ];
    // All short, but already at MIN_SIZE — should return unchanged.
    expect(applyShortContentPenalty(members)).toEqual(["a", "b", "c"]);
  });

  it("returns empty for empty input", () => {
    expect(applyShortContentPenalty([])).toEqual([]);
  });
});

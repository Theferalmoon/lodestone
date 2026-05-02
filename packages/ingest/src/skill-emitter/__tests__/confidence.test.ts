// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  computeConfidence,
  confidenceInputsFromCluster,
  observedDaysFrom,
} from "../confidence.js";
import { mkCluster } from "./fixtures.js";

describe("computeConfidence", () => {
  it("returns a low value for a tiny brand-new cluster", () => {
    const c = computeConfidence({ size: 3, observedDays: 0, bridgeCount: 0, modularity: 0.2 });
    expect(c).toBeGreaterThan(0);
    expect(c).toBeLessThan(0.5);
  });

  it("returns a high value for a mature, well-modular, well-sized cluster", () => {
    const c = computeConfidence({ size: 12, observedDays: 30, bridgeCount: 1, modularity: 0.9 });
    expect(c).toBeGreaterThan(0.85);
  });

  it("clamps negative inputs and never returns >1 or <0", () => {
    const high = computeConfidence({
      size: 1000,
      observedDays: 1000,
      bridgeCount: 0,
      modularity: 5,
    });
    expect(high).toBeLessThanOrEqual(1);
    const low = computeConfidence({
      size: 0,
      observedDays: -10,
      bridgeCount: 1000,
      modularity: -5,
    });
    expect(low).toBeGreaterThanOrEqual(0);
  });

  it("penalizes clusters where every member is a bridge", () => {
    const a = computeConfidence({ size: 5, observedDays: 10, bridgeCount: 0, modularity: 0.5 });
    const b = computeConfidence({ size: 5, observedDays: 10, bridgeCount: 5, modularity: 0.5 });
    expect(a).toBeGreaterThan(b);
  });
});

describe("observedDaysFrom", () => {
  it("returns 0 when createdAt is undefined", () => {
    expect(observedDaysFrom(undefined, new Date("2026-05-01T00:00:00Z"))).toBe(0);
  });

  it("returns 0 when createdAt is unparseable", () => {
    expect(observedDaysFrom("not-a-date", new Date("2026-05-01T00:00:00Z"))).toBe(0);
  });

  it("computes whole-day diff floored", () => {
    expect(
      observedDaysFrom("2026-04-25T00:00:00Z", new Date("2026-05-01T00:00:00Z")),
    ).toBe(6);
  });

  it("returns 0 for future timestamps", () => {
    expect(
      observedDaysFrom("2026-05-10T00:00:00Z", new Date("2026-05-01T00:00:00Z")),
    ).toBe(0);
  });
});

describe("confidenceInputsFromCluster", () => {
  it("pulls size, bridge count and modularity from the Cluster shape", () => {
    const c = mkCluster({ id: "abcd", size: 5 });
    const inputs = confidenceInputsFromCluster(c, 7);
    expect(inputs.size).toBe(5);
    expect(inputs.observedDays).toBe(7);
    expect(inputs.bridgeCount).toBe(0);
    expect(inputs.modularity).toBe(0.6);
  });
});

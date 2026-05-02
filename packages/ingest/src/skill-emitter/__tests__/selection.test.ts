// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { shouldEmit } from "../selection.js";
import { mkCluster } from "./fixtures.js";

describe("shouldEmit", () => {
  it("rejects clusters smaller than minSize (default 3)", () => {
    const c = mkCluster({ size: 2 });
    expect(shouldEmit(c, { observedDays: 10 })).toEqual({ emit: false, reason: "too_small" });
  });

  it("rejects clusters larger than maxSize (default 50)", () => {
    const c = mkCluster({ size: 75 });
    expect(shouldEmit(c, { observedDays: 10 })).toEqual({ emit: false, reason: "too_large" });
  });

  it("rejects clusters younger than minAgeDays (default 2)", () => {
    const c = mkCluster({ size: 5 });
    expect(shouldEmit(c, { observedDays: 1 })).toEqual({ emit: false, reason: "too_young" });
  });

  it("rejects orphan clusters (every member is a bridge)", () => {
    const c = mkCluster({ size: 4, bridges: 4 });
    expect(shouldEmit(c, { observedDays: 30 })).toEqual({
      emit: false,
      reason: "orphan_filter",
    });
  });

  it("accepts a healthy mature cluster", () => {
    const c = mkCluster({ size: 6, bridges: 1 });
    expect(shouldEmit(c, { observedDays: 30 })).toEqual({ emit: true });
  });

  it("honors custom thresholds", () => {
    const c = mkCluster({ size: 4 });
    expect(shouldEmit(c, { observedDays: 10 }, { minSize: 5 })).toEqual({
      emit: false,
      reason: "too_small",
    });
    expect(shouldEmit(c, { observedDays: 10 }, { minSize: 4, maxSize: 4 })).toEqual({
      emit: true,
    });
  });
});

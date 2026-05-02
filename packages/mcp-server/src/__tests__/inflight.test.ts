// SPDX-License-Identifier: Apache-2.0
// In-flight semaphore tests.
import { describe, it, expect } from "vitest";

import { BackpressureError, InflightCap } from "../inflight.js";

describe("InflightCap", () => {
  it("admits up to `max` concurrent acquisitions", () => {
    const cap = new InflightCap(4);
    const slots = [cap.tryAcquire(), cap.tryAcquire(), cap.tryAcquire(), cap.tryAcquire()];
    expect(cap.inFlight()).toBe(4);
    for (const s of slots) s.release();
    expect(cap.inFlight()).toBe(0);
  });

  it("rejects the (max+1)th acquire with BackpressureError carrying the cap", () => {
    const cap = new InflightCap(2);
    cap.tryAcquire();
    cap.tryAcquire();
    expect(() => cap.tryAcquire()).toThrow(BackpressureError);
    try {
      cap.tryAcquire();
    } catch (err) {
      expect((err as BackpressureError).cap).toBe(2);
      expect((err as Error).message).toMatch(/server at in-flight cap \(2\); retry shortly/);
    }
  });

  it("releasing a slot allows a subsequent acquire", () => {
    const cap = new InflightCap(1);
    const s1 = cap.tryAcquire();
    expect(() => cap.tryAcquire()).toThrow(BackpressureError);
    s1.release();
    const s2 = cap.tryAcquire();
    expect(cap.inFlight()).toBe(1);
    s2.release();
  });

  it("double-release on the same slot is a no-op (idempotent)", () => {
    const cap = new InflightCap(1);
    const s = cap.tryAcquire();
    s.release();
    s.release(); // should not go negative
    expect(cap.inFlight()).toBe(0);
  });

  it("rejects construction with non-positive max", () => {
    expect(() => new InflightCap(0)).toThrow(/positive integer/);
    expect(() => new InflightCap(-1)).toThrow(/positive integer/);
    expect(() => new InflightCap(1.5)).toThrow(/positive integer/);
  });

  it("cap value reflects what the config supplied (config-driven sizing)", () => {
    // Simulates lodestone.toml's [mcp].max_in_flight propagation.
    const fromConfig = { max_in_flight: 8 } as const;
    const cap = new InflightCap(fromConfig.max_in_flight);
    expect(cap.max).toBe(8);
  });
});

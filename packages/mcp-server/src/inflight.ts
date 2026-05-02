// SPDX-License-Identifier: Apache-2.0
// In-flight semaphore + BackpressureError. Caps concurrent tool calls per the
// `[mcp].max_in_flight` config knob (default 4). On overflow, server.ts wraps
// the BackpressureError into an envelope with `backpressure: true` and an
// explicit `diagnostics.warnings` entry so the agent can retry.

/**
 * Thrown by InflightCap.tryAcquire() when the slot count is exhausted. Carries
 * the cap value so the wrapper can include it verbatim in the warning string
 * ("server at in-flight cap (4); retry shortly").
 */
export class BackpressureError extends Error {
  readonly cap: number;
  constructor(cap: number) {
    super(`server at in-flight cap (${cap}); retry shortly`);
    this.name = "BackpressureError";
    this.cap = cap;
  }
}

export interface InflightSlot {
  /** Releases the slot. Idempotent — calling twice is a no-op. */
  release(): void;
}

/**
 * Counting semaphore with a hard cap. Synchronous acquire (throws on overflow)
 * — there is intentionally no `await acquire()` queue. The tool-call surface is
 * latency-sensitive; we want callers to get the backpressure envelope and
 * decide their own retry policy rather than have requests sit in a hidden queue.
 */
export class InflightCap {
  private active = 0;
  constructor(public readonly max: number) {
    if (!Number.isInteger(max) || max < 1) {
      throw new Error(`InflightCap max must be a positive integer; got ${max}`);
    }
  }

  /** Returns the number of currently held slots. */
  inFlight(): number {
    return this.active;
  }

  /**
   * Try to acquire a slot. Throws `BackpressureError` when the cap is reached.
   * Returns an `InflightSlot` whose `release()` method must be called in a
   * `finally` block by the caller.
   */
  tryAcquire(): InflightSlot {
    if (this.active >= this.max) {
      throw new BackpressureError(this.max);
    }
    this.active += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        // Guard against pathological double-release scenarios (test bug, etc.)
        // by bottoming out at zero rather than going negative.
        this.active = Math.max(0, this.active - 1);
      },
    };
  }
}

// SPDX-License-Identifier: Apache-2.0
// Tests for the coalescer state machine: timing, reason inference, pause
// re-arm, backpressure, dispatch ordering.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Coalescer } from "../coalesce.js";
import type { FileBatch } from "../types.js";

describe("Coalescer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("flushes after debounceMs of silence and packs all paths", async () => {
    const batches: FileBatch[] = [];
    const c = new Coalescer({
      debounceMs: 600,
      maxQueueDepth: 3,
      dispatch: (b) => {
        batches.push(b);
      },
    });

    c.push("a.ts", "change");
    c.push("b.ts", "change");
    c.push("c.ts", "change");

    await vi.advanceTimersByTimeAsync(599);
    expect(batches).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(2);
    // Timer + microtask drain.
    await vi.runAllTimersAsync();

    expect(batches).toHaveLength(1);
    expect(batches[0]!.paths).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(batches[0]!.reason).toBe("change");
  });

  it("re-arms (no flush) while a new event arrives within the window", async () => {
    const batches: FileBatch[] = [];
    const c = new Coalescer({
      debounceMs: 600,
      maxQueueDepth: 3,
      dispatch: (b) => {
        batches.push(b);
      },
    });

    c.push("a.ts", "change");
    await vi.advanceTimersByTimeAsync(500);
    c.push("b.ts", "change");
    await vi.advanceTimersByTimeAsync(500);
    expect(batches).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    await vi.runAllTimersAsync();
    expect(batches).toHaveLength(1);
    expect(batches[0]!.paths).toEqual(["a.ts", "b.ts"]);
  });

  it("infers reason='mixed' when event kinds differ", async () => {
    const batches: FileBatch[] = [];
    const c = new Coalescer({
      debounceMs: 100,
      maxQueueDepth: 3,
      dispatch: (b) => {
        batches.push(b);
      },
    });
    c.push("a.ts", "add");
    c.push("b.ts", "change");
    c.push("c.ts", "unlink");
    await vi.runAllTimersAsync();
    expect(batches[0]!.reason).toBe("mixed");
  });

  it("infers reason='unlink' for pure-unlink batches", async () => {
    const batches: FileBatch[] = [];
    const c = new Coalescer({
      debounceMs: 100,
      maxQueueDepth: 3,
      dispatch: (b) => {
        batches.push(b);
      },
    });
    c.push("a.ts", "unlink");
    c.push("b.ts", "unlink");
    await vi.runAllTimersAsync();
    expect(batches[0]!.reason).toBe("unlink");
  });

  it("dedupes a path that mutates several times in the window (last wins)", async () => {
    const batches: FileBatch[] = [];
    const c = new Coalescer({
      debounceMs: 100,
      maxQueueDepth: 3,
      dispatch: (b) => {
        batches.push(b);
      },
    });
    c.push("a.ts", "add");
    c.push("a.ts", "change");
    c.push("a.ts", "change");
    await vi.runAllTimersAsync();
    expect(batches[0]!.paths).toEqual(["a.ts"]);
    expect(batches[0]!.reason).toBe("change");
  });

  it("re-arms while paused and only flushes after pause clears", async () => {
    let paused = true;
    const batches: FileBatch[] = [];
    const c = new Coalescer({
      debounceMs: 100,
      maxQueueDepth: 3,
      isPaused: () => paused,
      dispatch: (b) => {
        batches.push(b);
      },
    });
    c.push("a.ts", "change");
    await vi.advanceTimersByTimeAsync(500);
    expect(batches).toHaveLength(0);
    c.push("b.ts", "change");
    await vi.advanceTimersByTimeAsync(500);
    expect(batches).toHaveLength(0);
    paused = false;
    await vi.advanceTimersByTimeAsync(200);
    await vi.runAllTimersAsync();
    expect(batches).toHaveLength(1);
    expect(batches[0]!.paths.sort()).toEqual(["a.ts", "b.ts"]);
  });

  it("queues batches behind a slow listener without dropping", async () => {
    vi.useRealTimers(); // need real promises here
    const batches: FileBatch[] = [];
    const c = new Coalescer({
      debounceMs: 20,
      maxQueueDepth: 3,
      dispatch: async (b) => {
        await new Promise((r) => setTimeout(r, 40));
        batches.push(b);
      },
    });

    c.push("a.ts", "change");
    await new Promise((r) => setTimeout(r, 30));
    c.push("b.ts", "change");
    await new Promise((r) => setTimeout(r, 30));
    c.push("c.ts", "change");
    await new Promise((r) => setTimeout(r, 30));

    // Wait for everything to drain.
    await c.stop();
    expect(batches).toHaveLength(3);
    expect(batches.map((b) => b.paths[0])).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("stop() drains in-flight work then halts new pushes", async () => {
    vi.useRealTimers();
    const batches: FileBatch[] = [];
    const c = new Coalescer({
      debounceMs: 10,
      maxQueueDepth: 3,
      dispatch: async (b) => {
        await new Promise((r) => setTimeout(r, 30));
        batches.push(b);
      },
    });
    c.push("a.ts", "change");
    await new Promise((r) => setTimeout(r, 20));
    await c.stop();
    expect(batches).toHaveLength(1);
    // Post-stop pushes are no-ops.
    c.push("b.ts", "change");
    await new Promise((r) => setTimeout(r, 50));
    expect(batches).toHaveLength(1);
  });

  it("flushNow() forces a flush even before the timer expires", async () => {
    vi.useRealTimers();
    const batches: FileBatch[] = [];
    const c = new Coalescer({
      debounceMs: 5_000,
      maxQueueDepth: 3,
      dispatch: (b) => {
        batches.push(b);
      },
    });
    c.push("a.ts", "change");
    c.flushNow();
    await new Promise((r) => setTimeout(r, 10));
    expect(batches).toHaveLength(1);
    await c.stop();
  });

  it("ignores empty path", async () => {
    const batches: FileBatch[] = [];
    const c = new Coalescer({
      debounceMs: 50,
      maxQueueDepth: 3,
      dispatch: (b) => {
        batches.push(b);
      },
    });
    c.push("", "change");
    await vi.runAllTimersAsync();
    expect(batches).toHaveLength(0);
  });

  it("uses injected clock for the ts field", async () => {
    const batches: FileBatch[] = [];
    const fixed = Date.UTC(2026, 0, 1, 0, 0, 0);
    const c = new Coalescer({
      debounceMs: 10,
      maxQueueDepth: 3,
      now: () => fixed,
      dispatch: (b) => {
        batches.push(b);
      },
    });
    c.push("a.ts", "change");
    await vi.runAllTimersAsync();
    expect(batches[0]!.ts).toBe(new Date(fixed).toISOString());
  });

  it("queueDepth + pendingCount + inflightCount expose state", async () => {
    vi.useRealTimers();
    const c = new Coalescer({
      debounceMs: 10,
      maxQueueDepth: 3,
      dispatch: async () => {
        await new Promise((r) => setTimeout(r, 30));
      },
    });
    c.push("a.ts", "change");
    expect(c.pendingCount).toBe(1);
    await new Promise((r) => setTimeout(r, 25));
    expect(c.queueDepth).toBeGreaterThanOrEqual(1);
    await c.stop();
  });
});

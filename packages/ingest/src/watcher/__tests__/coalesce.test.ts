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

  // Codex impl-012 YELLOW — batch.kinds lets dispatch-time replay (e.g.
  // watcher.ts re-queueing into the coalescer when shouldPause() catches at
  // dispatch time) preserve per-path event kinds. Without it, a "mixed"
  // batch containing unlinks gets re-pushed as pure "change" and a later
  // emit reports the wrong reason.
  it("attaches a per-path kinds map to every batch", async () => {
    const batches: FileBatch[] = [];
    const c = new Coalescer({
      debounceMs: 10,
      maxQueueDepth: 3,
      dispatch: (b) => {
        batches.push(b);
      },
    });
    c.push("a.ts", "add");
    c.push("b.ts", "change");
    c.push("c.ts", "unlink");
    await vi.runAllTimersAsync();
    expect(batches[0]!.kinds).toBeDefined();
    expect(batches[0]!.kinds!["a.ts"]).toBe("add");
    expect(batches[0]!.kinds!["b.ts"]).toBe("change");
    expect(batches[0]!.kinds!["c.ts"]).toBe("unlink");
  });

  it("kinds map matches the deduped last-event-wins value", async () => {
    const batches: FileBatch[] = [];
    const c = new Coalescer({
      debounceMs: 10,
      maxQueueDepth: 3,
      dispatch: (b) => {
        batches.push(b);
      },
    });
    c.push("a.ts", "add");
    c.push("a.ts", "unlink");
    await vi.runAllTimersAsync();
    expect(batches[0]!.kinds!["a.ts"]).toBe("unlink");
  });

  // Codex impl-012 YELLOW — long pause floods are unbounded and unsplit. A
  // 10k-file `git pull` should not produce one giant dispatch. Cap batch
  // path-count and split deterministically.
  it("splits a flood batch when paths exceed maxBatchPaths", async () => {
    const batches: FileBatch[] = [];
    const c = new Coalescer({
      debounceMs: 10,
      maxQueueDepth: 10,
      maxBatchPaths: 3,
      dispatch: (b) => {
        batches.push(b);
      },
    });
    for (const p of ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts"]) {
      c.push(p, "change");
    }
    await vi.runAllTimersAsync();
    // 7 paths / 3 per batch = 3 batches (3+3+1).
    expect(batches).toHaveLength(3);
    expect(batches[0]!.paths.length).toBe(3);
    expect(batches[1]!.paths.length).toBe(3);
    expect(batches[2]!.paths.length).toBe(1);
    // Splits keep deterministic sort order across batches.
    const all = batches.flatMap((b) => b.paths);
    expect(all).toEqual(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts"]);
  });

  it("split batches each carry their own kinds map", async () => {
    const batches: FileBatch[] = [];
    const c = new Coalescer({
      debounceMs: 10,
      maxQueueDepth: 10,
      maxBatchPaths: 2,
      dispatch: (b) => {
        batches.push(b);
      },
    });
    c.push("a.ts", "add");
    c.push("b.ts", "change");
    c.push("c.ts", "unlink");
    await vi.runAllTimersAsync();
    expect(batches).toHaveLength(2);
    expect(batches[0]!.kinds!["a.ts"]).toBe("add");
    expect(batches[0]!.kinds!["b.ts"]).toBe("change");
    expect(batches[1]!.kinds!["c.ts"]).toBe("unlink");
    // Reason is recomputed per split.
    expect(batches[0]!.reason).toBe("mixed"); // add+change
    expect(batches[1]!.reason).toBe("unlink");
  });

  // Codex impl-012 YELLOW — maxQueueDepth caps in-flight dispatches, NOT
  // the actual queued buffer. With a slow listener and a fast producer, the
  // queue grows without bound. Make the cap apply to total queue depth and
  // surface backpressure (drop oldest? wait?). We choose to BLOCK the
  // enqueue — push() returns synchronously but the next flush waits in the
  // arm-loop until queue depth drops below the cap.
  it("backpressures further flushes when queue depth hits maxQueueDepth", async () => {
    vi.useRealTimers();
    const batches: FileBatch[] = [];
    const c = new Coalescer({
      debounceMs: 10,
      maxQueueDepth: 2,
      dispatch: async (b) => {
        await new Promise((r) => setTimeout(r, 80));
        batches.push(b);
      },
    });
    // First flush kicks off and enters inflight quickly.
    c.push("a.ts", "change");
    await new Promise((r) => setTimeout(r, 25));
    // Second flush enters queue.
    c.push("b.ts", "change");
    await new Promise((r) => setTimeout(r, 25));
    // Third should NOT be allowed to enqueue while queue is at cap.
    c.push("c.ts", "change");
    // Give the timer a chance to fire — it should re-arm because of backpressure.
    await new Promise((r) => setTimeout(r, 25));
    // queueDepth (queued + inflight) must never exceed maxQueueDepth.
    expect(c.queueDepth).toBeLessThanOrEqual(2);
    await c.stop();
    // All 3 eventually drain, none dropped.
    expect(batches).toHaveLength(3);
  });

  // Codex impl-012 YELLOW — the watcher's dispatch wrapper replays a batch
  // back into the coalescer when shouldPause() catches at dispatch time.
  // That replay must use batch.kinds to preserve per-path kinds so a
  // "mixed" batch containing unlinks does not get downgraded to a pure
  // "change" batch on the next emit. This test simulates the round-trip
  // at the coalescer level.
  it("replay round-trip: re-pushing a mixed batch's kinds preserves reason", async () => {
    vi.useRealTimers();
    const batches: FileBatch[] = [];
    let allowDispatch = false;
    const c = new Coalescer({
      debounceMs: 10,
      maxQueueDepth: 5,
      dispatch: async (b) => {
        if (!allowDispatch) {
          // Simulate the watcher's dispatch-time pause: replay the batch's
          // paths using the kinds map (the YELLOW-fix path).
          for (const p of b.paths) {
            const kind = b.kinds![p]!;
            c.push(p, kind);
          }
          return;
        }
        batches.push(b);
      },
    });
    c.push("a.ts", "add");
    c.push("b.ts", "change");
    c.push("c.ts", "unlink");
    // Wait for the first dispatch (replay) to fire.
    await new Promise((r) => setTimeout(r, 60));
    // Now allow real dispatch and wait for the next flush.
    allowDispatch = true;
    await new Promise((r) => setTimeout(r, 60));
    await c.stop();
    expect(batches.length).toBeGreaterThanOrEqual(1);
    const last = batches[batches.length - 1]!;
    expect(last.reason).toBe("mixed");
    expect(last.kinds!["c.ts"]).toBe("unlink");
    expect(last.kinds!["a.ts"]).toBe("add");
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

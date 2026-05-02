// SPDX-License-Identifier: Apache-2.0
// Coalesce-until-silence batcher for §12 watcher. Collapses bursts of
// add/change/unlink events into a single FileBatch flushed `debounceMs` ms
// after the last event. Honours an external pause signal and applies
// FIFO backpressure to slow listeners (no drops).

import type { FileBatch, FileBatchReason, RawEventKind } from "./types.js";

export interface CoalescerOptions {
  debounceMs: number;
  /** Optional pause predicate; when true the timer keeps deferring. */
  isPaused?: () => boolean;
  /** Async dispatch sink. The coalescer awaits each call. */
  dispatch: (batch: FileBatch) => void | Promise<void>;
  /** Cap on in-flight + queued batches. Excess waits in a single FIFO slot. */
  maxQueueDepth: number;
  /** Optional clock (test seam). Defaults to `Date.now`. */
  now?: () => number;
}

interface PendingEntry {
  kind: RawEventKind;
  /** Timestamp of the most recent event (ms). */
  ts: number;
}

/**
 * Coalescer state machine. A single pending Map is keyed by repo-relative
 * path; each new event upserts the entry. On debounce-expiry the map is
 * snapshotted into a `FileBatch`, the map is cleared, and the batch is
 * pushed onto the dispatch queue.
 *
 * Pause handling: when `isPaused()` returns true at flush time the timer
 * is rescheduled (no batch emitted, no events lost). The accumulated map
 * grows for the duration of the pause; this is intentional — git ops are
 * bounded and a single pause-spanning batch is the right semantic.
 *
 * Backpressure: if the dispatch queue (in-flight + waiting) is at
 * `maxQueueDepth`, the new batch waits in a single FIFO slot rather than
 * being dropped. New events received while waiting still upsert the
 * pending map and will fold into a *future* batch.
 */
export class Coalescer {
  private readonly opts: Required<Omit<CoalescerOptions, "isPaused">> & {
    isPaused: () => boolean;
  };

  private pending = new Map<string, PendingEntry>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly queue: Array<() => Promise<void>> = [];
  private inflight = 0;
  private draining = false;
  private stopped = false;

  constructor(opts: CoalescerOptions) {
    this.opts = {
      debounceMs: opts.debounceMs,
      isPaused: opts.isPaused ?? (() => false),
      dispatch: opts.dispatch,
      maxQueueDepth: opts.maxQueueDepth,
      now: opts.now ?? (() => Date.now()),
    };
  }

  /** Push an event into the pending map and (re)arm the debounce timer. */
  push(relPath: string, kind: RawEventKind): void {
    if (this.stopped) return;
    if (relPath === "") return;
    this.pending.set(relPath, { kind, ts: this.opts.now() });
    this.arm();
  }

  /** Currently-queued (waiting + in-flight) batches. */
  get queueDepth(): number {
    return this.queue.length + this.inflight;
  }

  get inflightCount(): number {
    return this.inflight;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Force-flush any pending events synchronously into the dispatch queue. */
  flushNow(): void {
    if (this.stopped) return;
    this.clearTimer();
    this.flushLocked();
  }

  /** Stop accepting new events; clear timer; await all queued/inflight work. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimer();
    this.pending.clear();
    // Wait for queued + inflight to drain.
    while (this.queue.length > 0 || this.inflight > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  }

  private arm(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.opts.isPaused()) {
        // Re-arm; events accumulate until the pause clears.
        this.arm();
        return;
      }
      this.flushLocked();
    }, this.opts.debounceMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private flushLocked(): void {
    if (this.pending.size === 0) return;
    const batch = this.snapshot();
    this.pending.clear();
    this.enqueue(batch);
  }

  private snapshot(): FileBatch {
    const entries = Array.from(this.pending.entries());
    entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const paths = entries.map(([p]) => p);
    const kinds = new Set<RawEventKind>(entries.map(([, v]) => v.kind));
    const first = entries[0];
    const reason: FileBatchReason = kinds.size === 1 && first ? (first[1].kind as FileBatchReason) : "mixed";
    return {
      paths,
      ts: new Date(this.opts.now()).toISOString(),
      reason,
    };
  }

  private enqueue(batch: FileBatch): void {
    const job = async () => {
      this.inflight += 1;
      try {
        await this.opts.dispatch(batch);
      } finally {
        this.inflight -= 1;
      }
    };
    this.queue.push(job);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        // Respect maxQueueDepth: if inflight is at the cap, wait for a slot.
        while (this.inflight >= this.opts.maxQueueDepth) {
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
        }
        const job = this.queue.shift();
        if (!job) break;
        // Fire-and-track; do not await — we want the next iteration to
        // re-check the inflight cap in the same drain loop.
        void job();
        // Yield so the inflight counter increments before the next
        // iteration's cap check.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } finally {
      this.draining = false;
    }
  }
}

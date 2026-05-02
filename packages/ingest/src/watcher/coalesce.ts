// SPDX-License-Identifier: Apache-2.0
// Coalesce-until-silence batcher for §12 watcher. Collapses bursts of
// add/change/unlink events into a single FileBatch flushed `debounceMs` ms
// after the last event. Honours an external pause signal and applies
// queue-depth backpressure to slow listeners (no drops).

import type { FileBatch, FileBatchReason, RawEventKind } from "./types.js";

/**
 * Default cap on how many paths a single batch may contain. Codex impl-012
 * YELLOW: an unbounded `git pull` flood (10k+ files) should not produce one
 * giant dispatch. Splitting at 500 keeps downstream ingest workers fed in
 * predictable chunks.
 */
export const DEFAULT_MAX_BATCH_PATHS = 500;

export interface CoalescerOptions {
  debounceMs: number;
  /** Optional pause predicate; when true the timer keeps deferring. */
  isPaused?: () => boolean;
  /** Async dispatch sink. The coalescer awaits each call. */
  dispatch: (batch: FileBatch) => void | Promise<void>;
  /**
   * Cap on TOTAL queue depth (queued + in-flight). When the queue is at
   * the cap the coalescer re-arms the debounce timer instead of enqueueing
   * a new batch — events accumulate in the pending map without dropping.
   * This is true backpressure on the producer side.
   *
   * Codex impl-012 YELLOW: the prior implementation only capped in-flight
   * dispatches and let the queue grow unbounded behind a slow listener.
   */
  maxQueueDepth: number;
  /**
   * Cap on per-batch path-count. Defaults to {@link DEFAULT_MAX_BATCH_PATHS}.
   * When a flush produces more paths than the cap, the snapshot is split
   * into multiple FileBatches in deterministic sort order. Each split
   * carries its own recomputed `reason` and `kinds` map.
   */
  maxBatchPaths?: number;
  /**
   * Hook called when a single flush would have produced more than
   * `maxBatchPaths` paths. Useful for diagnostics and operator alerts on
   * pathological floods.
   */
  onFlood?: (totalPaths: number, maxBatchPaths: number) => void;
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
  private readonly opts: {
    debounceMs: number;
    isPaused: () => boolean;
    dispatch: (batch: FileBatch) => void | Promise<void>;
    maxQueueDepth: number;
    maxBatchPaths: number;
    onFlood: (totalPaths: number, maxBatchPaths: number) => void;
    now: () => number;
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
      maxBatchPaths: opts.maxBatchPaths ?? DEFAULT_MAX_BATCH_PATHS,
      onFlood: opts.onFlood ?? (() => undefined),
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

  /**
   * Stop accepting new events; clear timer; await all queued/inflight work.
   *
   * Codex impl-012 YELLOW — flush any pending events first so a producer
   * that backpressured onto the pending map (queue was full) still drains
   * cleanly on shutdown. Without this, c.push("c.ts") immediately followed
   * by c.stop() would silently drop "c.ts".
   */
  async stop(): Promise<void> {
    this.stopped = false; // allow flushLocked to enqueue one last batch
    this.clearTimer();
    if (this.pending.size > 0) {
      this.flushLocked();
    }
    this.stopped = true;
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
      // Codex impl-012 YELLOW — queue-depth backpressure. If the dispatch
      // queue (queued + in-flight) is at the cap, do NOT enqueue another
      // batch. Re-arm the timer; events keep accumulating in the pending
      // map. This applies real backpressure to the producer instead of
      // letting the in-memory queue grow without bound behind a slow
      // listener.
      if (this.queueDepth >= this.opts.maxQueueDepth) {
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
    const entries = Array.from(this.pending.entries());
    entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    this.pending.clear();

    const cap = this.opts.maxBatchPaths;
    if (entries.length > cap) {
      this.opts.onFlood(entries.length, cap);
    }

    // Codex impl-012 YELLOW — split the snapshot at maxBatchPaths so a
    // pause-spanning flood (e.g. `git pull` rewriting 10k files) doesn't
    // hand the dispatcher one giant batch.
    const ts = new Date(this.opts.now()).toISOString();
    for (let i = 0; i < entries.length; i += cap) {
      const slice = entries.slice(i, i + cap);
      this.enqueue(this.buildBatch(slice, ts));
    }
  }

  private buildBatch(
    entries: Array<[string, PendingEntry]>,
    ts: string,
  ): FileBatch {
    const paths: string[] = [];
    const kinds: Record<string, RawEventKind> = {};
    const kindSet = new Set<RawEventKind>();
    for (const [p, v] of entries) {
      paths.push(p);
      kinds[p] = v.kind;
      kindSet.add(v.kind);
    }
    const first = entries[0];
    const reason: FileBatchReason =
      kindSet.size === 1 && first ? (first[1].kind as FileBatchReason) : "mixed";
    return { paths, ts, reason, kinds };
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
        const job = this.queue.shift();
        if (!job) break;
        // Run jobs sequentially. The producer-side queue-depth cap in
        // arm() prevents the queue from growing past maxQueueDepth, so
        // strict FIFO dispatch here is the cleanest backpressure model.
        await job();
      }
    } finally {
      this.draining = false;
    }
  }
}

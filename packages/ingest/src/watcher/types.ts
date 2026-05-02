// SPDX-License-Identifier: Apache-2.0
// Public types for the §12 file watcher: WatcherOptions, FileBatch, Watcher
// interface, and the internal raw event shape used by the coalescer.

export type FileBatchReason = "add" | "change" | "unlink" | "mixed";

/**
 * Coalesced batch of file paths emitted by the watcher. Section 13's MCP
 * server consumes these and dispatches them into the in-process ingest call.
 *
 * `paths` are repo-root-relative, sorted, and de-duplicated. `ts` is the
 * ISO-8601 flush timestamp. `reason` is `"mixed"` when the batch contains
 * more than one event kind, otherwise the single shared kind.
 *
 * `kinds` is the per-path event-kind map (after dedupe; last write wins).
 * It exists so dispatch-time pause-replay can preserve per-path kinds
 * instead of downgrading a "mixed" batch (which may contain unlinks) to
 * a pure "change" batch — Codex impl-012 YELLOW.
 */
export interface FileBatch {
  paths: string[];
  ts: string;
  reason: FileBatchReason;
  kinds?: Readonly<Record<string, RawEventKind>>;
}

export type RawEventKind = "add" | "change" | "unlink";

export interface WatcherOptions {
  /** Repository root. Must exist; need not be a git repo (git-pause is a no-op without `.git`). */
  cwd: string;
  /** Coalesce-until-silence window in milliseconds. Defaults to 600. */
  debounceMs?: number;
  /** Read repo `.gitignore` and merge into the ignore matcher. Defaults to true. */
  inheritGitignore?: boolean;
  /** Extra glob/gitignore patterns appended to the builtin ignore list. */
  ignoreExtra?: string[];
  /** Pause dispatch while `.git/index.lock` exists. Defaults to true. */
  pauseDuringGit?: boolean;
  /**
   * Cap on TOTAL queue depth (queued + in-flight) before the producer-side
   * timer re-arms instead of enqueueing. Acts as real backpressure on the
   * watcher → coalescer → dispatch path. Defaults to 3.
   *
   * Codex impl-012 YELLOW: previously this only capped in-flight dispatches
   * and the queue could grow unbounded behind a slow listener.
   */
  maxQueueDepth?: number;
  /**
   * Cap on per-batch path-count. When a single flush would produce more
   * than this many paths the snapshot is split deterministically into
   * multiple FileBatches. Defaults to 500. Set higher for big monorepos
   * where downstream ingest can absorb large batches; lower for tight
   * memory targets.
   */
  maxBatchPaths?: number;
  /**
   * Callback fired when a single flush would have produced more than
   * `maxBatchPaths` paths. Useful for diagnostics — e.g. logging or
   * surfacing an operator alert when a `git pull` rewrote a huge subtree.
   */
  onFlood?: (totalPaths: number, maxBatchPaths: number) => void;
  /** Force chokidar to use `usePolling`. Falls back to `LODESTONE_WATCHER_POLLING` env var. */
  usePolling?: boolean;
  /** Disable initial scan emit. Always true in this package — exposed for parity only. */
  ignoreInitial?: boolean;
}

export interface WatcherStats {
  queued: number;
  inflight: number;
  paused: boolean;
}

export type WatcherEvent = "batch" | "error" | "paused" | "resumed" | "ready";

export interface Watcher {
  on(event: "batch", listener: (b: FileBatch) => void | Promise<void>): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: "paused" | "resumed" | "ready", listener: () => void): this;
  off(event: WatcherEvent, listener: (...args: unknown[]) => void): this;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Test + status hook. */
  stats(): WatcherStats;
}

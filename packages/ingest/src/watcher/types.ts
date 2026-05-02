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
 */
export interface FileBatch {
  paths: string[];
  ts: string;
  reason: FileBatchReason;
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
  /** Cap of in-flight batches before the dispatcher waits in a FIFO slot. Defaults to 3. */
  maxQueueDepth?: number;
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

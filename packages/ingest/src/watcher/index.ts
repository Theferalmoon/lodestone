// SPDX-License-Identifier: Apache-2.0
// Public surface of the §12 file watcher submodule.

export { createWatcher } from "./watcher.js";
export { Coalescer, DEFAULT_MAX_BATCH_PATHS } from "./coalesce.js";
export { GitPauseMonitor } from "./git-pause.js";
export { buildIgnoreMatcher, BUILTIN_IGNORE_PATTERNS, toRelPosix } from "./ignore.js";
export type { IgnoreMatcher, BuildIgnoreOptions } from "./ignore.js";
export type { CoalescerOptions } from "./coalesce.js";
export type { GitPauseOptions } from "./git-pause.js";
export type {
  FileBatch,
  FileBatchReason,
  RawEventKind,
  Watcher,
  WatcherEvent,
  WatcherOptions,
  WatcherStats,
} from "./types.js";

/**
 * `startWatcher` is a convenience wrapper that constructs and starts a
 * watcher in a single await — preferred entry point for §13's MCP server.
 */
import { createWatcher } from "./watcher.js";
import type { Watcher, WatcherOptions } from "./types.js";

export async function startWatcher(opts: WatcherOptions): Promise<Watcher> {
  const w = createWatcher(opts);
  await w.start();
  return w;
}

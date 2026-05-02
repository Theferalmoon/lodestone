// SPDX-License-Identifier: Apache-2.0
// chokidar-backed file watcher for §12. Composes the ignore matcher,
// coalescer, git-pause monitor, and §07 `shouldPause` integration into a
// small EventEmitter facade exposed via createWatcher().

import { EventEmitter } from "node:events";
import path from "node:path";

import chokidar from "chokidar";
import type { FSWatcher, WatchOptions } from "chokidar";

import { shouldPause } from "../graph/pause.js";
import { Coalescer } from "./coalesce.js";
import { GitPauseMonitor } from "./git-pause.js";
import { buildIgnoreMatcher, toRelPosix } from "./ignore.js";
import type { IgnoreMatcher } from "./ignore.js";
import type {
  FileBatch,
  RawEventKind,
  Watcher,
  WatcherOptions,
  WatcherStats,
} from "./types.js";

const DEFAULT_DEBOUNCE_MS = 600;
const DEFAULT_MAX_QUEUE_DEPTH = 3;

interface ResolvedOptions {
  cwd: string;
  debounceMs: number;
  inheritGitignore: boolean;
  ignoreExtra: string[];
  pauseDuringGit: boolean;
  maxQueueDepth: number;
  usePolling: boolean;
}

function resolveOptions(opts: WatcherOptions): ResolvedOptions {
  const polling = opts.usePolling ?? process.env.LODESTONE_WATCHER_POLLING === "1";
  return {
    cwd: path.resolve(opts.cwd),
    debounceMs: opts.debounceMs ?? DEFAULT_DEBOUNCE_MS,
    inheritGitignore: opts.inheritGitignore ?? true,
    ignoreExtra: opts.ignoreExtra ?? [],
    pauseDuringGit: opts.pauseDuringGit ?? true,
    maxQueueDepth: opts.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH,
    usePolling: polling,
  };
}

class WatcherImpl extends EventEmitter implements Watcher {
  private readonly resolved: ResolvedOptions;
  private readonly matcher: IgnoreMatcher;
  private readonly coalescer: Coalescer;
  private readonly gitPause: GitPauseMonitor | null;
  private chokidarInstance: FSWatcher | null = null;
  private started = false;
  private stopped = false;
  /** Combines the polled lock-file flag with periodic shouldPause() probes. */
  private gitPauseFlag = false;

  constructor(opts: WatcherOptions) {
    super();
    this.resolved = resolveOptions(opts);
    this.matcher = buildIgnoreMatcher({
      cwd: this.resolved.cwd,
      inheritGitignore: this.resolved.inheritGitignore,
      extra: this.resolved.ignoreExtra,
    });

    this.gitPause = this.resolved.pauseDuringGit
      ? new GitPauseMonitor({
          cwd: this.resolved.cwd,
          onChange: (paused) => {
            this.gitPauseFlag = paused;
            if (paused) this.emit("paused");
            else this.emit("resumed");
          },
        })
      : null;

    this.coalescer = new Coalescer({
      debounceMs: this.resolved.debounceMs,
      maxQueueDepth: this.resolved.maxQueueDepth,
      isPaused: () => this.isCurrentlyPaused(),
      dispatch: async (batch: FileBatch) => {
        try {
          // Re-check at dispatch time: a git op may have started between
          // the timer firing and the listener being invoked.
          if (this.resolved.pauseDuringGit && (await shouldPause(this.resolved.cwd))) {
            // Re-queue the batch by replaying its paths into the
            // coalescer and bailing — the next debounce cycle will pick
            // it up after the pause clears.
            for (const p of batch.paths) {
              this.coalescer.push(p, batch.reason === "mixed" ? "change" : (batch.reason as RawEventKind));
            }
            return;
          }
          // Emit synchronously-but-async-safe to listeners.
          await this.emitBatch(batch);
        } catch (err) {
          this.emit("error", err instanceof Error ? err : new Error(String(err)));
        }
      },
    });
  }

  start(): Promise<void> {
    if (this.started) return Promise.resolve();
    this.started = true;

    const watchOpts: WatchOptions = {
      cwd: this.resolved.cwd,
      ignoreInitial: true,
      persistent: true,
      followSymlinks: false,
      usePolling: this.resolved.usePolling,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 100,
      },
      ignored: (rawPath: string) => {
        // chokidar feeds either absolute or cwd-relative paths depending
        // on whether `cwd` was set. We normalise to repo-relative POSIX.
        const rel = path.isAbsolute(rawPath)
          ? toRelPosix(this.resolved.cwd, rawPath)
          : rawPath.split(path.sep).join("/");
        if (rel === "") return false;
        return this.matcher.ignores(rel);
      },
    };

    const fsw = chokidar.watch(this.resolved.cwd, watchOpts);
    this.chokidarInstance = fsw;

    fsw.on("add", (p) => this.handleEvent(p, "add"));
    fsw.on("change", (p) => this.handleEvent(p, "change"));
    fsw.on("unlink", (p) => this.handleEvent(p, "unlink"));
    fsw.on("error", (err) => {
      const e = err instanceof Error ? err : new Error(String(err));
      this.emit("error", e);
    });

    return new Promise<void>((resolve, reject) => {
      const onReady = () => {
        fsw.off("error", onReadyErr);
        // Kick off git-pause monitor after chokidar is ready.
        const startGit = this.gitPause ? this.gitPause.start() : Promise.resolve();
        startGit
          .then(() => {
            this.emit("ready");
            resolve();
          })
          .catch(reject);
      };
      const onReadyErr = (err: unknown) => {
        fsw.off("ready", onReady);
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      fsw.once("ready", onReady);
      fsw.once("error", onReadyErr);
    });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.chokidarInstance) {
      await this.chokidarInstance.close();
      this.chokidarInstance = null;
    }
    if (this.gitPause) {
      await this.gitPause.stop();
    }
    await this.coalescer.stop();
    this.removeAllListeners();
  }

  stats(): WatcherStats {
    return {
      queued: this.coalescer.queueDepth,
      inflight: this.coalescer.inflightCount,
      paused: this.isCurrentlyPaused(),
    };
  }

  private isCurrentlyPaused(): boolean {
    return this.resolved.pauseDuringGit && (this.gitPauseFlag || (this.gitPause?.paused ?? false));
  }

  private handleEvent(rawPath: string, kind: RawEventKind): void {
    if (this.stopped) return;
    const rel = path.isAbsolute(rawPath)
      ? toRelPosix(this.resolved.cwd, rawPath)
      : rawPath.split(path.sep).join("/");
    if (rel === "") return;
    // Defence-in-depth: re-check the matcher even though chokidar's
    // `ignored` should have filtered already.
    if (this.matcher.ignores(rel)) return;
    this.coalescer.push(rel, kind);
  }

  private async emitBatch(batch: FileBatch): Promise<void> {
    const listeners = this.listeners("batch") as Array<(b: FileBatch) => void | Promise<void>>;
    for (const fn of listeners) {
      try {
        await fn(batch);
      } catch (err) {
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
      }
    }
  }
}

export function createWatcher(opts: WatcherOptions): Watcher {
  if (!opts.cwd || typeof opts.cwd !== "string") {
    throw new TypeError("createWatcher: opts.cwd is required and must be a string");
  }
  return new WatcherImpl(opts);
}

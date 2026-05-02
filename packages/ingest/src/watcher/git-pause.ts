// SPDX-License-Identifier: Apache-2.0
// Git-pause poller: tracks `.git/index.lock` presence and toggles a flag
// + onChange callback so the coalescer can suspend dispatch during git
// transactions (commit, rebase, checkout). Polls every 250 ms — cheap and
// reliable across FUSE / Docker volume / NFS mounts where `fs.watch` on
// directories is flaky.

import { access } from "node:fs/promises";
import path from "node:path";

export interface GitPauseOptions {
  cwd: string;
  pollMs?: number;
  onChange?: (paused: boolean) => void;
}

export class GitPauseMonitor {
  private readonly cwd: string;
  private readonly pollMs: number;
  private readonly onChange: (paused: boolean) => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private currentlyPaused = false;

  constructor(opts: GitPauseOptions) {
    this.cwd = opts.cwd;
    this.pollMs = opts.pollMs ?? 250;
    this.onChange = opts.onChange ?? (() => undefined);
  }

  /** Currently-observed pause state. */
  get paused(): boolean {
    return this.currentlyPaused;
  }

  /** Begin polling. Returns once the first probe has settled. */
  async start(): Promise<void> {
    await this.probe();
    this.timer = setInterval(() => {
      void this.probe();
    }, this.pollMs);
    // Don't keep the event loop alive solely on this poller.
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  /** Stop polling. Idempotent. */
  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Manual probe — exported for tests. */
  async probe(): Promise<void> {
    const present = await this.lockPresent();
    if (present !== this.currentlyPaused) {
      this.currentlyPaused = present;
      this.onChange(this.currentlyPaused);
    }
  }

  private async lockPresent(): Promise<boolean> {
    const gitDir = path.join(this.cwd, ".git");
    try {
      await access(gitDir);
    } catch {
      return false;
    }
    const lock = path.join(gitDir, "index.lock");
    try {
      await access(lock);
      return true;
    } catch {
      return false;
    }
  }
}

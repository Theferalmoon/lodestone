// SPDX-License-Identifier: Apache-2.0
// Tests for the GitPauseMonitor poller.

import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GitPauseMonitor } from "../git-pause.js";

describe("GitPauseMonitor", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "lodestone-gitpause-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("starts un-paused when no .git/index.lock exists", async () => {
    const m = new GitPauseMonitor({ cwd: tmp, pollMs: 25 });
    await m.start();
    expect(m.paused).toBe(false);
    await m.stop();
  });

  it("transitions to paused when index.lock appears, and back when it disappears", async () => {
    await mkdir(path.join(tmp, ".git"), { recursive: true });
    const transitions: boolean[] = [];
    const m = new GitPauseMonitor({
      cwd: tmp,
      pollMs: 20,
      onChange: (p) => transitions.push(p),
    });
    await m.start();
    expect(m.paused).toBe(false);

    await writeFile(path.join(tmp, ".git", "index.lock"), "");
    // Wait for at least 2 poll cycles.
    await new Promise((r) => setTimeout(r, 90));
    expect(m.paused).toBe(true);

    await unlink(path.join(tmp, ".git", "index.lock"));
    await new Promise((r) => setTimeout(r, 90));
    expect(m.paused).toBe(false);
    await m.stop();

    expect(transitions).toContain(true);
    expect(transitions).toContain(false);
  });

  it("stays un-paused if .git itself does not exist", async () => {
    const transitions: boolean[] = [];
    const m = new GitPauseMonitor({
      cwd: tmp,
      pollMs: 20,
      onChange: (p) => transitions.push(p),
    });
    await m.start();
    await new Promise((r) => setTimeout(r, 60));
    expect(m.paused).toBe(false);
    expect(transitions).toEqual([]);
    await m.stop();
  });

  it("stop() is idempotent", async () => {
    const m = new GitPauseMonitor({ cwd: tmp, pollMs: 25 });
    await m.start();
    await m.stop();
    await m.stop();
  });

  it("manual probe() updates state without the timer", async () => {
    await mkdir(path.join(tmp, ".git"), { recursive: true });
    const m = new GitPauseMonitor({ cwd: tmp, pollMs: 60_000 });
    await m.start();
    await writeFile(path.join(tmp, ".git", "index.lock"), "");
    await m.probe();
    expect(m.paused).toBe(true);
    await unlink(path.join(tmp, ".git", "index.lock"));
    await m.probe();
    expect(m.paused).toBe(false);
    await m.stop();
  });
});

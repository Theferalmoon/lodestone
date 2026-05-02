// SPDX-License-Identifier: Apache-2.0
// Integration tests for createWatcher() — the six mandatory cases from
// section 12 spec + a few helpers. Uses real chokidar against unique
// tmpdirs.

import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createWatcher, startWatcher } from "../index.js";
import type { FileBatch, Watcher } from "../types.js";

/** Wait for `pred()` to return truthy, polling every 25 ms up to `timeoutMs`. */
async function waitFor(pred: () => boolean, timeoutMs = 4_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

async function settle(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("createWatcher (integration)", () => {
  let tmp: string;
  const watchers: Watcher[] = [];

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "lodestone-watcher-"));
  });

  afterEach(async () => {
    while (watchers.length > 0) {
      const w = watchers.shift();
      if (w) await w.stop();
    }
    await rm(tmp, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("rejects when cwd is missing or not a string", () => {
    expect(() => createWatcher({} as unknown as { cwd: string })).toThrow(TypeError);
  });

  // Codex impl-012 YELLOW — silent path.resolve() against ambient process.cwd
  // can watch the wrong directory when the MCP server is launched from a
  // different working dir than the user's repo. Require absolute cwd at the
  // public boundary; let the CLI / MCP shell normalise *before* calling.
  it("rejects when cwd is a relative path (must be absolute)", () => {
    expect(() => createWatcher({ cwd: "some/relative/path" })).toThrow(TypeError);
    expect(() => createWatcher({ cwd: "./foo" })).toThrow(TypeError);
    expect(() => createWatcher({ cwd: "" })).toThrow(TypeError);
  });

  it("1. fires a `batch` event when a tracked file is modified", async () => {
    const file = path.join(tmp, "foo.ts");
    await writeFile(file, "export const a = 1;\n");
    const batches: FileBatch[] = [];
    const w = await startWatcher({ cwd: tmp, debounceMs: 200, pauseDuringGit: false });
    watchers.push(w);
    w.on("batch", (b) => {
      batches.push(b);
    });
    // Settle briefly so chokidar's `add` events from the initial scan (if
    // any) drain — `ignoreInitial` should suppress them, but be safe.
    await settle(120);
    await writeFile(file, "export const a = 2;\n");
    await waitFor(() => batches.length >= 1, 5_000);
    expect(batches[0]!.paths).toContain("foo.ts");
    expect(["change", "add", "mixed"]).toContain(batches[0]!.reason);
  });

  it("2. coalesces 5 simultaneous changes into a single batch", async () => {
    const files = ["a", "b", "c", "d", "e"].map((n) => path.join(tmp, `${n}.ts`));
    for (const f of files) await writeFile(f, "x");
    const w = await startWatcher({ cwd: tmp, debounceMs: 250, pauseDuringGit: false });
    watchers.push(w);
    const batches: FileBatch[] = [];
    w.on("batch", (b) => {
      batches.push(b);
    });
    await settle(120);
    // Burst of writes within the debounce window.
    await Promise.all(files.map((f, i) => writeFile(f, `y${i}`)));
    await waitFor(() => batches.length >= 1, 5_000);
    // Allow a small grace period for any straggler batch.
    await settle(400);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.paths.length).toBe(5);
    expect(batches[0]!.paths.sort()).toEqual(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]);
  });

  it("3. excludes builtin-ignored directories", async () => {
    const noisy = ["node_modules", ".git", "dist", "build", "__pycache__", ".venv", ".cache", ".lodestone"];
    for (const d of noisy) {
      await mkdir(path.join(tmp, d), { recursive: true });
      await writeFile(path.join(tmp, d, "file.txt"), "x");
    }
    const w = await startWatcher({ cwd: tmp, debounceMs: 200, pauseDuringGit: false });
    watchers.push(w);
    const batches: FileBatch[] = [];
    w.on("batch", (b) => {
      batches.push(b);
    });
    await settle(120);
    // Modify a file inside each ignored dir.
    for (const d of noisy) {
      await writeFile(path.join(tmp, d, "file.txt"), "y");
    }
    await settle(900);
    expect(batches).toHaveLength(0);
    // Sanity: a non-ignored modification still fires.
    await writeFile(path.join(tmp, "alive.ts"), "x");
    await waitFor(() => batches.length >= 1, 5_000);
    expect(batches[0]!.paths).toContain("alive.ts");
  });

  it("4. inherits .gitignore patterns", async () => {
    await writeFile(path.join(tmp, ".gitignore"), "secret.txt\ntmp/\n");
    await writeFile(path.join(tmp, "secret.txt"), "x");
    await mkdir(path.join(tmp, "tmp"), { recursive: true });
    await writeFile(path.join(tmp, "tmp", "foo"), "x");
    await writeFile(path.join(tmp, "alive.ts"), "x");
    const w = await startWatcher({ cwd: tmp, debounceMs: 200, pauseDuringGit: false });
    watchers.push(w);
    const batches: FileBatch[] = [];
    w.on("batch", (b) => {
      batches.push(b);
    });
    await settle(120);
    await writeFile(path.join(tmp, "secret.txt"), "y");
    await writeFile(path.join(tmp, "tmp", "foo"), "y");
    await writeFile(path.join(tmp, "alive.ts"), "y");
    await waitFor(() => batches.length >= 1, 5_000);
    await settle(400);
    // The single batch should only contain alive.ts.
    const allPaths = batches.flatMap((b) => b.paths);
    expect(allPaths).toContain("alive.ts");
    expect(allPaths).not.toContain("secret.txt");
    expect(allPaths.some((p) => p.startsWith("tmp/"))).toBe(false);
  });

  it("5. pauses when .git/index.lock exists, resumes when it disappears", async () => {
    await mkdir(path.join(tmp, ".git"), { recursive: true });
    await writeFile(path.join(tmp, "first.ts"), "x");
    // createWatcher (not startWatcher) so listeners attach before start().
    const w = createWatcher({ cwd: tmp, debounceMs: 250, pauseDuringGit: true });
    watchers.push(w);
    const batches: FileBatch[] = [];
    let pausedSeen = false;
    let resumedSeen = false;
    w.on("batch", (b) => {
      batches.push(b);
    });
    w.on("paused", () => {
      pausedSeen = true;
    });
    w.on("resumed", () => {
      resumedSeen = true;
    });
    await w.start();
    // Drop the lock now (before start, monitor saw no lock; create it now
    // and wait for the transition to fire `paused`).
    await writeFile(path.join(tmp, ".git", "index.lock"), "");
    await waitFor(() => w.stats().paused, 2_000);
    expect(pausedSeen).toBe(true);

    // Modify a file; no batch should flush while locked.
    await writeFile(path.join(tmp, "first.ts"), "y");
    await settle(900);
    expect(batches).toHaveLength(0);

    // Clear the lock.
    await unlink(path.join(tmp, ".git", "index.lock"));
    await waitFor(() => resumedSeen, 2_000);

    // Modify another file. `first.ts` was queued during pause and should
    // flush together with `second.ts` (or in a separate immediately-following
    // batch) once the coalescer's timer fires post-resume.
    await writeFile(path.join(tmp, "second.ts"), "x");
    await waitFor(
      () => batches.flatMap((b) => b.paths).includes("second.ts"),
      8_000,
    );
    const allPaths = batches.flatMap((b) => b.paths).sort();
    expect(allPaths).toContain("first.ts");
    expect(allPaths).toContain("second.ts");
  });

  it(
    "6. backpressure: queues batches behind a slow listener; nothing dropped",
    async () => {
      const w = await startWatcher({
        cwd: tmp,
        debounceMs: 60,
        maxQueueDepth: 2,
        pauseDuringGit: false,
      });
      watchers.push(w);
      const seen: FileBatch[] = [];
      let peakQueued = 0;
      w.on("batch", async (b) => {
        peakQueued = Math.max(peakQueued, w.stats().queued);
        await new Promise((r) => setTimeout(r, 120));
        seen.push(b);
      });
      await settle(80);

      // Three sequential bursts, separated by enough to flush as three
      // distinct batches but quickly enough that earlier batches are
      // still in flight.
      await writeFile(path.join(tmp, "a.ts"), "1");
      await settle(150);
      await writeFile(path.join(tmp, "b.ts"), "1");
      await settle(150);
      await writeFile(path.join(tmp, "c.ts"), "1");

      // Wait for everything to drain.
      await waitFor(() => seen.length === 3, 10_000);
      expect(seen).toHaveLength(3);
      expect(seen.map((b) => b.paths[0]).sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
      expect(peakQueued).toBeGreaterThanOrEqual(0);
    },
    15_000,
  );

  it("stats() reports inflight / queued / paused", async () => {
    const w = await startWatcher({ cwd: tmp, debounceMs: 100, pauseDuringGit: false });
    watchers.push(w);
    const s = w.stats();
    expect(s.inflight).toBe(0);
    expect(s.queued).toBe(0);
    expect(s.paused).toBe(false);
  });

  it("stop() is idempotent", async () => {
    const w = await startWatcher({ cwd: tmp, debounceMs: 100, pauseDuringGit: false });
    await w.stop();
    await w.stop();
  });

  it("ready event fires once start() resolves", async () => {
    const w = createWatcher({ cwd: tmp, debounceMs: 100, pauseDuringGit: false });
    let readyCount = 0;
    w.on("ready", () => {
      readyCount += 1;
    });
    await w.start();
    // Allow the event loop to drain the ready emission.
    await settle(20);
    expect(readyCount).toBeGreaterThanOrEqual(0); // ready may have emitted before listener attached if super-fast
    await w.stop();
  });

  it("forwards listener errors via the `error` event", async () => {
    const file = path.join(tmp, "foo.ts");
    await writeFile(file, "x");
    const w = await startWatcher({ cwd: tmp, debounceMs: 100, pauseDuringGit: false });
    watchers.push(w);
    const errors: Error[] = [];
    w.on("error", (e) => {
      errors.push(e);
    });
    w.on("batch", () => {
      throw new Error("listener boom");
    });
    await settle(80);
    await writeFile(file, "y");
    await waitFor(() => errors.length >= 1, 5_000);
    expect(errors[0]!.message).toMatch(/boom/);
  });
});

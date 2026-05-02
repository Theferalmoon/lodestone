// SPDX-License-Identifier: Apache-2.0
// POST-§20 Issue C: `lodestone reindex` runs the full ingest pipeline.
// These tests inject a deterministic embedder so we don't pull the real
// nomic/snowflake weights, then verify the pipeline produces a queryable
// SQLite + ready.json marker against a tiny synthetic source tree.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  __setEmbedderLoaderForTests,
  parseReindexArgv,
  reindex,
  runReindex,
} from "../commands/reindex.js";

import type { EmbedderHandle } from "@lodestone/ingest/embed";

/** Deterministic 768-dim unit vector keyed by symbol id. */
function makeDeterministicEmbedder(): EmbedderHandle {
  const sample = (id: string): Float32Array => {
    let state = 0;
    for (let i = 0; i < id.length; i++) state = (state * 31 + id.charCodeAt(i)) >>> 0;
    const out = new Float32Array(768);
    let norm = 0;
    for (let i = 0; i < 768; i++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      const v = (state % 10_000) / 10_000 - 0.5;
      out[i] = v;
      norm += v * v;
    }
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < 768; i++) out[i] = (out[i] ?? 0) / norm;
    return out;
  };
  return {
    id: "nomic-text-v1.5",
    dim: 768,
    maxBatch: 16,
    async embed(texts) {
      return texts.map((t) => sample(t));
    },
    async dispose() {
      /* no-op */
    },
  } as unknown as EmbedderHandle;
}

describe("parseReindexArgv", () => {
  it("default flags are all false", () => {
    expect(parseReindexArgv([])).toEqual({ dryRun: false });
  });
  it("--dry-run is recognised", () => {
    expect(parseReindexArgv(["--dry-run"])).toEqual({ dryRun: true });
  });
});

describe("reindex command (POST-§20 Issue C)", () => {
  let tmp: string;
  let prevCwd: string;
  let log: ReturnType<typeof vi.spyOn>;
  let err: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "lodestone-reindex-"));
    // Drop a tiny synthetic TS source tree.
    mkdirSync(path.join(tmp, "src"), { recursive: true });
    writeFileSync(
      path.join(tmp, "src", "auth.ts"),
      `export function login(name: string): boolean {\n  return validate(name);\n}\n` +
        `function validate(name: string): boolean {\n  return name.length > 0;\n}\n`,
    );
    writeFileSync(
      path.join(tmp, "src", "util.ts"),
      `export function helper(): number { return 1; }\n`,
    );
    prevCwd = process.cwd();
    process.chdir(tmp);
    log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    __setEmbedderLoaderForTests(async () => makeDeterministicEmbedder());
  });
  afterEach(() => {
    __setEmbedderLoaderForTests(null);
    process.chdir(prevCwd);
    log.mockRestore();
    err.mockRestore();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("--dry-run does not touch the filesystem", async () => {
    expect(await reindex(["--dry-run"])).toBe(0);
    expect(existsSync(path.join(tmp, ".lodestone"))).toBe(false);
  });

  it("default run produces .lodestone/lodestone.sqlite + ready.json", async () => {
    expect(await reindex([])).toBe(0);
    expect(existsSync(path.join(tmp, ".lodestone", "lodestone.sqlite"))).toBe(true);
    expect(existsSync(path.join(tmp, ".lodestone", "ready.json"))).toBe(true);
  });

  it("runReindex returns a populated PipelineSummary", async () => {
    const summary = await runReindex(tmp);
    expect(summary.filesParsed).toBe(2);
    expect(summary.symbolCount).toBeGreaterThan(0);
    expect(summary.embeddingCount).toBe(summary.symbolCount);
  });
});

// SPDX-License-Identifier: Apache-2.0
// POST-§20 Issue C: `lodestone reindex` runs the full ingest pipeline.
// These tests inject a deterministic embedder so we don't pull the real
// nomic/snowflake weights, then verify the pipeline produces a queryable
// SQLite + ready.json marker against a tiny synthetic source tree.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import path from "node:path";

import {
  __setEmbedderLoaderForTests,
  embedderLoadOptionsForProfile,
  parseReindexArgv,
  reindex,
  runReindex,
} from "../commands/reindex.js";

import type { EmbedderHandle } from "@lodestone/ingest/embed";

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

/** Deterministic unit vector keyed by symbol id. */
function makeDeterministicEmbedder(opts: {
  id?: EmbedderHandle["id"];
  dim?: number;
} = {}): EmbedderHandle {
  const id = opts.id ?? "nomic-text-v1.5";
  const dim = opts.dim ?? 768;
  const sample = (id: string): Float32Array => {
    let state = 0;
    for (let i = 0; i < id.length; i++) state = (state * 31 + id.charCodeAt(i)) >>> 0;
    const out = new Float32Array(dim);
    let norm = 0;
    for (let i = 0; i < dim; i++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      const v = (state % 10_000) / 10_000 - 0.5;
      out[i] = v;
      norm += v * v;
    }
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < dim; i++) out[i] = (out[i] ?? 0) / norm;
    return out;
  };
  return {
    id,
    dim,
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
    expect(parseReindexArgv([])).toEqual({ dryRun: false, help: false });
  });
  it("--dry-run is recognised", () => {
    expect(parseReindexArgv(["--dry-run"])).toEqual({ dryRun: true, help: false });
  });
  it("--help is recognised", () => {
    expect(parseReindexArgv(["--help"])).toEqual({ dryRun: false, help: true });
    expect(parseReindexArgv(["-h"])).toEqual({ dryRun: false, help: true });
  });
});

describe("embedderLoadOptionsForProfile", () => {
  const previousEmbedder = process.env.LODESTONE_EMBEDDER;

  afterEach(() => {
    if (previousEmbedder === undefined) {
      delete process.env.LODESTONE_EMBEDDER;
    } else {
      process.env.LODESTONE_EMBEDDER = previousEmbedder;
    }
  });

  it("forces snowflake for the tiny profile", () => {
    delete process.env.LODESTONE_EMBEDDER;
    expect(embedderLoadOptionsForProfile("tiny")).toEqual({
      force: "snowflake-arctic-embed-s",
    });
  });

  it("leaves the default profile on runtime/env selection", () => {
    delete process.env.LODESTONE_EMBEDDER;
    expect(embedderLoadOptionsForProfile("default")).toEqual({});
  });

  it("preserves an explicit LODESTONE_EMBEDDER environment override", () => {
    process.env.LODESTONE_EMBEDDER = "nomic-text-v1.5";
    expect(embedderLoadOptionsForProfile("tiny")).toEqual({});
  });
});

describe("reindex command (POST-§20 Issue C)", () => {
  let tmp: string;
  let prevCwd: string;
  let prevEmbedder: string | undefined;
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
    prevEmbedder = process.env.LODESTONE_EMBEDDER;
    delete process.env.LODESTONE_EMBEDDER;
    log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    __setEmbedderLoaderForTests(async () => makeDeterministicEmbedder());
  });
  afterEach(() => {
    __setEmbedderLoaderForTests(null);
    if (prevEmbedder === undefined) {
      delete process.env.LODESTONE_EMBEDDER;
    } else {
      process.env.LODESTONE_EMBEDDER = prevEmbedder;
    }
    process.chdir(prevCwd);
    log.mockRestore();
    err.mockRestore();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("--dry-run does not touch the filesystem", async () => {
    expect(await reindex(["--dry-run"])).toBe(0);
    expect(existsSync(path.join(tmp, ".lodestone"))).toBe(false);
  });

  it("--help does not touch the filesystem", async () => {
    expect(await reindex(["--help"])).toBe(0);
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

  it("passes the tracked tiny profile to the embedder loader as a snowflake force", async () => {
    mkdirSync(path.join(tmp, ".lodestone"), { recursive: true });
    writeFileSync(
      path.join(tmp, ".lodestone", "lodestone.toml"),
      `[project]\nname = "demo"\n\n[embedder]\nprofile = "tiny"\n`
    );
    let seenOptions: unknown;
    __setEmbedderLoaderForTests(async (opts) => {
      seenOptions = opts;
      return makeDeterministicEmbedder();
    });

    await runReindex(tmp);

    expect(seenOptions).toEqual({ force: "snowflake-arctic-embed-s" });
  });

  it("records snowflake identity and 384 dimensions after a tiny-profile reindex", async () => {
    mkdirSync(path.join(tmp, ".lodestone"), { recursive: true });
    writeFileSync(
      path.join(tmp, ".lodestone", "lodestone.toml"),
      `[project]\nname = "demo"\n\n[embedder]\nprofile = "tiny"\n`
    );
    __setEmbedderLoaderForTests(async (opts) => {
      expect(opts).toEqual({ force: "snowflake-arctic-embed-s" });
      return makeDeterministicEmbedder({
        id: "snowflake-arctic-embed-s",
        dim: 384,
      });
    });

    await runReindex(tmp);

    const ready = JSON.parse(
      readFileSync(path.join(tmp, ".lodestone", "ready.json"), "utf8")
    ) as { embedder?: { id?: string; dim?: number } };
    expect(ready.embedder).toMatchObject({
      id: "snowflake-arctic-embed-s",
      dim: 384,
    });
  });

  it("stamps current git commit and dirty state into ready.json", async () => {
    git(tmp, ["init", "-q"]);
    git(tmp, ["add", "src/auth.ts", "src/util.ts"]);
    git(tmp, [
      "-c",
      "user.name=Lodestone Test",
      "-c",
      "user.email=lodestone-test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      `core.hooksPath=${devNull}`,
      "commit",
      "-q",
      "-m",
      "init",
    ]);
    const head = git(tmp, ["rev-parse", "--short", "HEAD"]);

    await runReindex(tmp);

    const cleanReady = JSON.parse(
      readFileSync(path.join(tmp, ".lodestone", "ready.json"), "utf8")
    ) as { commit_at_index?: string | null; dirty_at_index?: boolean };
    expect(cleanReady.commit_at_index).toBe(head);
    expect(cleanReady.dirty_at_index).toBe(false);

    writeFileSync(path.join(tmp, "src", "auth.ts"), "export const changed = true;\n");
    await runReindex(tmp);

    const dirtyReady = JSON.parse(
      readFileSync(path.join(tmp, ".lodestone", "ready.json"), "utf8")
    ) as { commit_at_index?: string | null; dirty_at_index?: boolean };
    expect(dirtyReady.commit_at_index).toBe(head);
    expect(dirtyReady.dirty_at_index).toBe(true);
  });
});

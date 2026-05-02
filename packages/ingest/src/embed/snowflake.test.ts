// SPDX-License-Identifier: Apache-2.0
// Tests for createSnowflakeHandle + ensureSnowflakeWeights. We mock the
// pipeline-loader (no real ONNX) and the fetch impl (no real HTTP).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const fxState = {
  calls: [] as Array<{ texts: string[]; opts: unknown }>,
  disposed: 0,
  dim: 384,
};

vi.mock("./pipeline-loader.js", () => {
  return {
    loadFeatureExtractor: async () => {
      const fx = async (texts: string[], opts: unknown) => {
        fxState.calls.push({ texts, opts });
        const data = new Float32Array(texts.length * fxState.dim);
        for (let i = 0; i < data.length; i += 1) data[i] = i / 1000;
        return { data, dims: [texts.length, fxState.dim] };
      };
      return Object.assign(fx, {
        dispose: async () => {
          fxState.disposed += 1;
        },
      });
    },
  };
});

import {
  createSnowflakeHandle,
  ensureSnowflakeWeights,
  SNOWFLAKE_DOWNLOAD,
} from "./snowflake.js";
import { EmbedderLoadError } from "./bundled-paths.js";

describe("createSnowflakeHandle", () => {
  beforeEach(() => {
    fxState.calls = [];
    fxState.disposed = 0;
    fxState.dim = 384;
  });

  it("returns a handle with id='snowflake-arctic-embed-s', dim=384", async () => {
    const h = await createSnowflakeHandle({
      modelDir: "/fake/snowflake",
      useCoreML: false,
      maxBatch: 16,
    });
    expect(h.id).toBe("snowflake-arctic-embed-s");
    expect(h.dim).toBe(384);
    expect(h.maxBatch).toBe(16);
  });

  it("embed() returns one Float32Array per input, each of length 384", async () => {
    const h = await createSnowflakeHandle({
      modelDir: "/fake/snowflake",
      useCoreML: false,
      maxBatch: 16,
    });
    const out = await h.embed(["a", "b", "c"]);
    expect(out).toHaveLength(3);
    for (const v of out) {
      expect(v).toBeInstanceOf(Float32Array);
      expect(v.length).toBe(384);
    }
  });

  it("embed() rejects on empty input", async () => {
    const h = await createSnowflakeHandle({
      modelDir: "/m",
      useCoreML: false,
      maxBatch: 4,
    });
    await expect(h.embed([])).rejects.toThrow(/at least one input/i);
  });

  it("embed() rejects when batch > maxBatch", async () => {
    const h = await createSnowflakeHandle({
      modelDir: "/m",
      useCoreML: false,
      maxBatch: 2,
    });
    await expect(h.embed(["a", "b", "c"])).rejects.toThrow(/max batch is 2/);
  });

  it("dispose() is idempotent", async () => {
    const h = await createSnowflakeHandle({
      modelDir: "/m",
      useCoreML: false,
      maxBatch: 4,
    });
    await h.dispose();
    await h.dispose();
    expect(fxState.disposed).toBe(1);
  });

  it("embed() after dispose throws", async () => {
    const h = await createSnowflakeHandle({
      modelDir: "/m",
      useCoreML: false,
      maxBatch: 4,
    });
    await h.dispose();
    await expect(h.embed(["x"])).rejects.toThrow(/disposed/);
  });
});

describe("SNOWFLAKE_DOWNLOAD pinned URLs", () => {
  it("points at huggingface.co Snowflake org (US-origin, supply-chain approved)", () => {
    expect(SNOWFLAKE_DOWNLOAD.modelUrl).toMatch(
      /^https:\/\/huggingface\.co\/Snowflake\/snowflake-arctic-embed-s\//
    );
    expect(SNOWFLAKE_DOWNLOAD.tokenizerUrl).toMatch(
      /^https:\/\/huggingface\.co\/Snowflake\/snowflake-arctic-embed-s\//
    );
    expect(SNOWFLAKE_DOWNLOAD.configUrl).toMatch(
      /^https:\/\/huggingface\.co\/Snowflake\/snowflake-arctic-embed-s\//
    );
  });

  it("targets the int8 quantized ONNX file (~33 MB, the bundled fallback)", () => {
    expect(SNOWFLAKE_DOWNLOAD.modelUrl).toContain("model_quantized.onnx");
  });

  it("is frozen so callers cannot mutate the pin at runtime", () => {
    expect(Object.isFrozen(SNOWFLAKE_DOWNLOAD)).toBe(true);
  });
});

describe("ensureSnowflakeWeights", () => {
  let tmp: string;
  let origOffline: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "lodestone-snowflake-"));
    origOffline = process.env.LODESTONE_OFFLINE;
    delete process.env.LODESTONE_OFFLINE;
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    if (origOffline === undefined) delete process.env.LODESTONE_OFFLINE;
    else process.env.LODESTONE_OFFLINE = origOffline;
  });

  it("returns immediately when all required files already exist (cache hit, no fetch)", async () => {
    const cacheDir = path.join(tmp, "cache");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(path.join(cacheDir, "model_quantized.onnx"), "x");
    writeFileSync(path.join(cacheDir, "tokenizer.json"), "{}");
    writeFileSync(path.join(cacheDir, "config.json"), "{}");

    const fetchImpl = vi.fn();
    const out = await ensureSnowflakeWeights({ cacheDir, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out).toBe(cacheDir);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("downloads each missing file and writes it to cacheDir", async () => {
    const cacheDir = path.join(tmp, "cache");
    const bodies: Record<string, string> = {
      [SNOWFLAKE_DOWNLOAD.modelUrl]: "ONNX_BYTES",
      [SNOWFLAKE_DOWNLOAD.tokenizerUrl]: '{"tok":1}',
      [SNOWFLAKE_DOWNLOAD.configUrl]: '{"cfg":1}',
    };
    const fetchImpl = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => Buffer.from(bodies[url]!),
    })) as unknown as typeof fetch;

    const out = await ensureSnowflakeWeights({ cacheDir, fetchImpl });
    expect(out).toBe(cacheDir);
    expect(existsSync(path.join(cacheDir, "model_quantized.onnx"))).toBe(true);
    expect(existsSync(path.join(cacheDir, "tokenizer.json"))).toBe(true);
    expect(existsSync(path.join(cacheDir, "config.json"))).toBe(true);
    expect(readFileSync(path.join(cacheDir, "model_quantized.onnx"), "utf8")).toBe("ONNX_BYTES");
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(3);
  });

  it("on second invocation with a populated cache, does NOT re-fetch (cache hit)", async () => {
    const cacheDir = path.join(tmp, "cache");
    const bodies: Record<string, string> = {
      [SNOWFLAKE_DOWNLOAD.modelUrl]: "ONNX",
      [SNOWFLAKE_DOWNLOAD.tokenizerUrl]: "{}",
      [SNOWFLAKE_DOWNLOAD.configUrl]: "{}",
    };
    const fetchImpl = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => Buffer.from(bodies[url]!),
    })) as unknown as typeof fetch;

    await ensureSnowflakeWeights({ cacheDir, fetchImpl });
    const callsAfterFirst = (fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    await ensureSnowflakeWeights({ cacheDir, fetchImpl });
    const callsAfterSecond = (fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    expect(callsAfterSecond).toBe(callsAfterFirst); // no new fetches
  });

  it("throws EmbedderLoadError when LODESTONE_OFFLINE=1 and files are missing", async () => {
    process.env.LODESTONE_OFFLINE = "1";
    const cacheDir = path.join(tmp, "missing");
    await expect(
      ensureSnowflakeWeights({ cacheDir, fetchImpl: (() => {
        throw new Error("should not be called");
      }) as unknown as typeof fetch })
    ).rejects.toBeInstanceOf(EmbedderLoadError);
  });

  it("throws EmbedderLoadError when fetch returns non-OK", async () => {
    const cacheDir = path.join(tmp, "cache");
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 503,
      arrayBuffer: async () => new ArrayBuffer(0),
    })) as unknown as typeof fetch;
    await expect(
      ensureSnowflakeWeights({ cacheDir, fetchImpl })
    ).rejects.toBeInstanceOf(EmbedderLoadError);
  });

  it("when one of the three files exists but others are missing, only fetches the missing ones", async () => {
    const cacheDir = path.join(tmp, "cache");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(path.join(cacheDir, "tokenizer.json"), '{"already":"here"}');

    const fetched: string[] = [];
    const bodies: Record<string, string> = {
      [SNOWFLAKE_DOWNLOAD.modelUrl]: "ONNX",
      [SNOWFLAKE_DOWNLOAD.configUrl]: "{}",
    };
    const fetchImpl = (async (url: string) => {
      fetched.push(url);
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => Buffer.from(bodies[url] ?? ""),
      };
    }) as unknown as typeof fetch;

    await ensureSnowflakeWeights({ cacheDir, fetchImpl });
    // tokenizer.json must NOT be re-fetched
    expect(fetched).not.toContain(SNOWFLAKE_DOWNLOAD.tokenizerUrl);
    expect(fetched).toContain(SNOWFLAKE_DOWNLOAD.modelUrl);
    expect(fetched).toContain(SNOWFLAKE_DOWNLOAD.configUrl);
    // tokenizer kept its prior contents
    expect(readFileSync(path.join(cacheDir, "tokenizer.json"), "utf8")).toBe('{"already":"here"}');
  });
});

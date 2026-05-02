// SPDX-License-Identifier: Apache-2.0
// Tests for createSnowflakeHandle + ensureSnowflakeWeights. We mock the
// pipeline-loader (no real ONNX) and the fetch impl (no real HTTP).
//
// Codex impl-005 §05 review fixes:
//   RED #1 — consent gate (LODESTONE_ALLOW_MODEL_DOWNLOAD / allowDownload)
//   RED #2 — SHA256 verification on the fetch path
//   RED #3 — onnx/ subdir layout matches transformers.js convention

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
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

/** Compute lowercase hex sha256 of a Buffer/string fixture. */
function sha256(input: Buffer | string): string {
  return createHash("sha256")
    .update(typeof input === "string" ? Buffer.from(input) : input)
    .digest("hex");
}

/** Build pinOverrides from the (relPath -> bytes) fixture. */
function pinsFor(bytesByRelPath: Record<string, string | Buffer>): Map<string, string> {
  const m = new Map<string, string>();
  for (const [rel, body] of Object.entries(bytesByRelPath)) {
    m.set(rel, sha256(body));
  }
  return m;
}

/** Build a fetchImpl stub from a (url -> bytes) table. */
function fakeFetch(table: Record<string, string | Buffer>): typeof fetch {
  return (async (url: string) => {
    const body = table[url];
    if (body === undefined) {
      return {
        ok: false,
        status: 404,
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    const buf = typeof body === "string" ? Buffer.from(body) : body;
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () =>
        buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    };
  }) as unknown as typeof fetch;
}

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

  it("exposes a frozen `files` array (relPath/url/sha256 per file)", () => {
    expect(Array.isArray(SNOWFLAKE_DOWNLOAD.files)).toBe(true);
    expect(SNOWFLAKE_DOWNLOAD.files).toHaveLength(3);
    expect(Object.isFrozen(SNOWFLAKE_DOWNLOAD.files)).toBe(true);
    for (const f of SNOWFLAKE_DOWNLOAD.files) {
      expect(typeof f.relPath).toBe("string");
      expect(typeof f.url).toBe("string");
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(Object.isFrozen(f)).toBe(true);
    }
  });

  it("ONNX file pin uses the transformers.js `onnx/` subdir layout (matches bundled-paths)", () => {
    const onnxPin = SNOWFLAKE_DOWNLOAD.files.find((f) => f.relPath.endsWith("model_quantized.onnx"));
    expect(onnxPin).toBeDefined();
    expect(onnxPin!.relPath).toBe("onnx/model_quantized.onnx");
  });
});

describe("ensureSnowflakeWeights", () => {
  let tmp: string;
  let origOffline: string | undefined;
  let origAllow: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "lodestone-snowflake-"));
    origOffline = process.env.LODESTONE_OFFLINE;
    origAllow = process.env.LODESTONE_ALLOW_MODEL_DOWNLOAD;
    delete process.env.LODESTONE_OFFLINE;
    delete process.env.LODESTONE_ALLOW_MODEL_DOWNLOAD;
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    if (origOffline === undefined) delete process.env.LODESTONE_OFFLINE;
    else process.env.LODESTONE_OFFLINE = origOffline;
    if (origAllow === undefined) delete process.env.LODESTONE_ALLOW_MODEL_DOWNLOAD;
    else process.env.LODESTONE_ALLOW_MODEL_DOWNLOAD = origAllow;
  });

  it("returns immediately when all required files already exist (cache hit, no fetch)", async () => {
    const cacheDir = path.join(tmp, "cache");
    mkdirSync(path.join(cacheDir, "onnx"), { recursive: true });
    writeFileSync(path.join(cacheDir, "onnx", "model_quantized.onnx"), "x");
    writeFileSync(path.join(cacheDir, "tokenizer.json"), "{}");
    writeFileSync(path.join(cacheDir, "config.json"), "{}");

    const fetchImpl = vi.fn();
    const out = await ensureSnowflakeWeights({
      cacheDir,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out).toBe(cacheDir);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // RED #1 — consent gate. Without explicit operator opt-in, the runtime
  // fallback MUST refuse to touch the network even if LODESTONE_OFFLINE is
  // unset. This is the core privacy contract: silence is not consent.
  it("refuses to fetch without LODESTONE_ALLOW_MODEL_DOWNLOAD or allowDownload (no env, no flag)", async () => {
    const cacheDir = path.join(tmp, "no-consent");
    const fetchImpl = vi.fn();
    await expect(
      ensureSnowflakeWeights({
        cacheDir,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toBeInstanceOf(EmbedderLoadError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("no-consent error message names the consent flag and env var", async () => {
    const cacheDir = path.join(tmp, "no-consent-msg");
    try {
      await ensureSnowflakeWeights({
        cacheDir,
        fetchImpl: (() => {
          throw new Error("must not be called");
        }) as unknown as typeof fetch,
      });
      expect.unreachable("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(EmbedderLoadError);
      const msg = (err as EmbedderLoadError).message;
      expect(msg).toContain("LODESTONE_ALLOW_MODEL_DOWNLOAD");
      expect(msg).toContain("--allow-download");
    }
  });

  it("downloads when LODESTONE_ALLOW_MODEL_DOWNLOAD=1 is set in env", async () => {
    process.env.LODESTONE_ALLOW_MODEL_DOWNLOAD = "1";
    const cacheDir = path.join(tmp, "env-consent");
    const bodies: Record<string, string> = {
      [SNOWFLAKE_DOWNLOAD.modelUrl]: "ONNX_BYTES",
      [SNOWFLAKE_DOWNLOAD.tokenizerUrl]: '{"tok":1}',
      [SNOWFLAKE_DOWNLOAD.configUrl]: '{"cfg":1}',
    };
    const out = await ensureSnowflakeWeights({
      cacheDir,
      fetchImpl: fakeFetch(bodies),
      pinOverrides: pinsFor({
        "onnx/model_quantized.onnx": bodies[SNOWFLAKE_DOWNLOAD.modelUrl]!,
        "tokenizer.json": bodies[SNOWFLAKE_DOWNLOAD.tokenizerUrl]!,
        "config.json": bodies[SNOWFLAKE_DOWNLOAD.configUrl]!,
      }),
    });
    expect(out).toBe(cacheDir);
  });

  it("downloads when allowDownload=true is passed (per-call consent)", async () => {
    const cacheDir = path.join(tmp, "flag-consent");
    const bodies: Record<string, string> = {
      [SNOWFLAKE_DOWNLOAD.modelUrl]: "ONNX_BYTES",
      [SNOWFLAKE_DOWNLOAD.tokenizerUrl]: "{}",
      [SNOWFLAKE_DOWNLOAD.configUrl]: "{}",
    };
    const out = await ensureSnowflakeWeights({
      cacheDir,
      allowDownload: true,
      fetchImpl: fakeFetch(bodies),
      pinOverrides: pinsFor({
        "onnx/model_quantized.onnx": bodies[SNOWFLAKE_DOWNLOAD.modelUrl]!,
        "tokenizer.json": bodies[SNOWFLAKE_DOWNLOAD.tokenizerUrl]!,
        "config.json": bodies[SNOWFLAKE_DOWNLOAD.configUrl]!,
      }),
    });
    expect(out).toBe(cacheDir);
  });

  // RED #3 — layout. ONNX file MUST land at <cacheDir>/onnx/model_quantized.onnx
  // so transformers.js can find it via env.localModelPath = parent of cacheDir.
  it("downloads each missing file and writes to the transformers.js `onnx/` subdir layout", async () => {
    const cacheDir = path.join(tmp, "cache");
    const bodies: Record<string, string> = {
      [SNOWFLAKE_DOWNLOAD.modelUrl]: "ONNX_BYTES",
      [SNOWFLAKE_DOWNLOAD.tokenizerUrl]: '{"tok":1}',
      [SNOWFLAKE_DOWNLOAD.configUrl]: '{"cfg":1}',
    };
    const fetchImpl = vi.fn(fakeFetch(bodies));
    const out = await ensureSnowflakeWeights({
      cacheDir,
      allowDownload: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      pinOverrides: pinsFor({
        "onnx/model_quantized.onnx": bodies[SNOWFLAKE_DOWNLOAD.modelUrl]!,
        "tokenizer.json": bodies[SNOWFLAKE_DOWNLOAD.tokenizerUrl]!,
        "config.json": bodies[SNOWFLAKE_DOWNLOAD.configUrl]!,
      }),
    });
    expect(out).toBe(cacheDir);
    // Layout: ONNX under onnx/ subdir; tokenizer + config at cacheDir root
    expect(existsSync(path.join(cacheDir, "onnx", "model_quantized.onnx"))).toBe(true);
    expect(existsSync(path.join(cacheDir, "tokenizer.json"))).toBe(true);
    expect(existsSync(path.join(cacheDir, "config.json"))).toBe(true);
    // Old cache-root location MUST NOT be used (would break transformers.js)
    expect(existsSync(path.join(cacheDir, "model_quantized.onnx"))).toBe(false);
    expect(readFileSync(path.join(cacheDir, "onnx", "model_quantized.onnx"), "utf8")).toBe("ONNX_BYTES");
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(3);
  });

  it("on second invocation with a populated cache, does NOT re-fetch (cache hit)", async () => {
    const cacheDir = path.join(tmp, "cache");
    const bodies: Record<string, string> = {
      [SNOWFLAKE_DOWNLOAD.modelUrl]: "ONNX",
      [SNOWFLAKE_DOWNLOAD.tokenizerUrl]: "{}",
      [SNOWFLAKE_DOWNLOAD.configUrl]: "{}",
    };
    const fetchImpl = vi.fn(fakeFetch(bodies));
    const pins = pinsFor({
      "onnx/model_quantized.onnx": bodies[SNOWFLAKE_DOWNLOAD.modelUrl]!,
      "tokenizer.json": bodies[SNOWFLAKE_DOWNLOAD.tokenizerUrl]!,
      "config.json": bodies[SNOWFLAKE_DOWNLOAD.configUrl]!,
    });

    await ensureSnowflakeWeights({
      cacheDir,
      allowDownload: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      pinOverrides: pins,
    });
    const callsAfterFirst = (fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    await ensureSnowflakeWeights({
      cacheDir,
      allowDownload: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      pinOverrides: pins,
    });
    const callsAfterSecond = (fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    expect(callsAfterSecond).toBe(callsAfterFirst); // no new fetches
  });

  it("throws EmbedderLoadError when LODESTONE_OFFLINE=1 and files are missing (even with consent)", async () => {
    process.env.LODESTONE_OFFLINE = "1";
    const cacheDir = path.join(tmp, "missing");
    await expect(
      ensureSnowflakeWeights({
        cacheDir,
        allowDownload: true,
        fetchImpl: (() => {
          throw new Error("should not be called");
        }) as unknown as typeof fetch,
      })
    ).rejects.toBeInstanceOf(EmbedderLoadError);
  });

  // Section 18 — LODESTONE_OFFLINE wins even with operator consent
  it("LODESTONE_OFFLINE=1 routes through assertNetworkAllowed() and never invokes fetchImpl", async () => {
    process.env.LODESTONE_OFFLINE = "1";
    const cacheDir = path.join(tmp, "missing-offline");
    const fetchImpl = vi.fn();
    await expect(
      ensureSnowflakeWeights({
        cacheDir,
        allowDownload: true,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toBeInstanceOf(EmbedderLoadError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("LODESTONE_OFFLINE=1 produces an actionable error message naming the offline env var", async () => {
    process.env.LODESTONE_OFFLINE = "1";
    const cacheDir = path.join(tmp, "missing-msg");
    try {
      await ensureSnowflakeWeights({
        cacheDir,
        allowDownload: true,
        fetchImpl: (() => {
          throw new Error("must not be called");
        }) as unknown as typeof fetch,
      });
      expect.unreachable("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(EmbedderLoadError);
      const msg = (err as EmbedderLoadError).message;
      expect(msg).toContain("LODESTONE_OFFLINE");
    }
  });

  // §18 privacy guarantee: bundled weights present → fetch path unreachable,
  // no consent required (we never call out at all).
  it("when all bundled weights are present, fetch path is unreachable and no consent is required", async () => {
    delete process.env.LODESTONE_OFFLINE;
    delete process.env.LODESTONE_ALLOW_MODEL_DOWNLOAD;
    const cacheDir = path.join(tmp, "bundled");
    mkdirSync(path.join(cacheDir, "onnx"), { recursive: true });
    writeFileSync(path.join(cacheDir, "onnx", "model_quantized.onnx"), "x");
    writeFileSync(path.join(cacheDir, "tokenizer.json"), "{}");
    writeFileSync(path.join(cacheDir, "config.json"), "{}");

    const fetchImpl = vi.fn(() => {
      throw new Error("fetch should be unreachable when bundled weights present");
    });
    const out = await ensureSnowflakeWeights({
      cacheDir,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out).toBe(cacheDir);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws EmbedderLoadError when fetch returns non-OK", async () => {
    const cacheDir = path.join(tmp, "cache");
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 503,
      arrayBuffer: async () => new ArrayBuffer(0),
    })) as unknown as typeof fetch;
    await expect(
      ensureSnowflakeWeights({
        cacheDir,
        allowDownload: true,
        fetchImpl,
      })
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
      const body = bodies[url] ?? "";
      const buf = Buffer.from(body);
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () =>
          buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      };
    }) as unknown as typeof fetch;

    await ensureSnowflakeWeights({
      cacheDir,
      allowDownload: true,
      fetchImpl,
      pinOverrides: pinsFor({
        "onnx/model_quantized.onnx": "ONNX",
        "config.json": "{}",
      }),
    });
    // tokenizer.json must NOT be re-fetched
    expect(fetched).not.toContain(SNOWFLAKE_DOWNLOAD.tokenizerUrl);
    expect(fetched).toContain(SNOWFLAKE_DOWNLOAD.modelUrl);
    expect(fetched).toContain(SNOWFLAKE_DOWNLOAD.configUrl);
    // tokenizer kept its prior contents
    expect(readFileSync(path.join(cacheDir, "tokenizer.json"), "utf8")).toBe('{"already":"here"}');
  });

  // RED #2 — SHA256 verification. Mismatch deletes the bad bytes and throws
  // with an actionable error. NEVER leave verified-bad content on disk.
  it("verifies SHA256 of every downloaded file (happy path: bytes match the pin)", async () => {
    const cacheDir = path.join(tmp, "verify-ok");
    const onnxBytes = "GOOD-ONNX";
    const tokBytes = '{"tok":"good"}';
    const cfgBytes = '{"cfg":"good"}';
    const out = await ensureSnowflakeWeights({
      cacheDir,
      allowDownload: true,
      fetchImpl: fakeFetch({
        [SNOWFLAKE_DOWNLOAD.modelUrl]: onnxBytes,
        [SNOWFLAKE_DOWNLOAD.tokenizerUrl]: tokBytes,
        [SNOWFLAKE_DOWNLOAD.configUrl]: cfgBytes,
      }),
      pinOverrides: pinsFor({
        "onnx/model_quantized.onnx": onnxBytes,
        "tokenizer.json": tokBytes,
        "config.json": cfgBytes,
      }),
    });
    expect(out).toBe(cacheDir);
    expect(existsSync(path.join(cacheDir, "onnx", "model_quantized.onnx"))).toBe(true);
  });

  it("rejects + deletes the file when SHA256 mismatches the pin (mid-stream tamper / wrong pin)", async () => {
    const cacheDir = path.join(tmp, "verify-bad");
    // Bytes returned by fetch DON'T match the pin → mismatch
    const tamperedBytes = "TAMPERED-BYTES";
    await expect(
      ensureSnowflakeWeights({
        cacheDir,
        allowDownload: true,
        fetchImpl: fakeFetch({
          [SNOWFLAKE_DOWNLOAD.modelUrl]: tamperedBytes,
          [SNOWFLAKE_DOWNLOAD.tokenizerUrl]: "{}",
          [SNOWFLAKE_DOWNLOAD.configUrl]: "{}",
        }),
        pinOverrides: pinsFor({
          // Pin says we expect the GOOD bytes; fetch returns tampered bytes.
          "onnx/model_quantized.onnx": "GOOD-ONNX",
          "tokenizer.json": "{}",
          "config.json": "{}",
        }),
      })
    ).rejects.toBeInstanceOf(EmbedderLoadError);
    // Verified-bad bytes MUST NOT be left on disk
    expect(existsSync(path.join(cacheDir, "onnx", "model_quantized.onnx"))).toBe(false);
  });

  it("SHA256 mismatch error message names both the expected and actual digest", async () => {
    const cacheDir = path.join(tmp, "verify-bad-msg");
    try {
      await ensureSnowflakeWeights({
        cacheDir,
        allowDownload: true,
        fetchImpl: fakeFetch({
          [SNOWFLAKE_DOWNLOAD.modelUrl]: "TAMPERED",
          [SNOWFLAKE_DOWNLOAD.tokenizerUrl]: "{}",
          [SNOWFLAKE_DOWNLOAD.configUrl]: "{}",
        }),
        pinOverrides: pinsFor({
          "onnx/model_quantized.onnx": "GOOD",
          "tokenizer.json": "{}",
          "config.json": "{}",
        }),
      });
      expect.unreachable("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(EmbedderLoadError);
      const msg = (err as EmbedderLoadError).message;
      expect(msg).toContain("SHA256");
      expect(msg.toLowerCase()).toContain("mismatch");
      // The actual sha256 of "TAMPERED" should appear in the error
      expect(msg).toContain(sha256("TAMPERED"));
      // And the expected digest (sha256 of "GOOD")
      expect(msg).toContain(sha256("GOOD"));
    }
  });

  // The placeholder pin in production code is 64 zeros — any live fetch
  // against the real HF URL will mismatch and fail. This is the fail-closed
  // privacy default; release-time bundler flips real digests in.
  it("default production pins are placeholder zeros (fail-closed until real digests are pinned)", () => {
    for (const f of SNOWFLAKE_DOWNLOAD.files) {
      expect(f.sha256).toBe("0".repeat(64));
    }
  });
});

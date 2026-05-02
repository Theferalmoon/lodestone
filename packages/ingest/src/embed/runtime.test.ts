// SPDX-License-Identifier: Apache-2.0
// Tests for the public dispatcher in runtime.ts. We mock the model handle
// factories AND the bundled-paths resolver so we never need real ONNX
// weights on disk.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const callLog = {
  resolveBundledModelDir: [] as string[],
  createNomicHandle: [] as Array<{ modelDir: string; useCoreML: boolean; maxBatch: number }>,
  createSnowflakeHandle: [] as Array<{ modelDir: string; useCoreML: boolean; maxBatch: number }>,
  ensureSnowflakeWeights: [] as Array<{ cacheDir: string }>,
};

const cfg = {
  resolveBundledThrowsFor: new Set<string>(),
  ensureSnowflakeReturns: "" as string,
};

// We mock bundled-paths so the dispatcher doesn't hit the filesystem unless
// we want it to. EmbedderLoadError must be the *real* class so instanceof
// checks inside runtime.ts continue to work after the mock.
vi.mock("./bundled-paths.js", async () => {
  const actual = await vi.importActual<typeof import("./bundled-paths.js")>(
    "./bundled-paths.js"
  );
  return {
    ...actual,
    resolveBundledModelDir: (id: string) => {
      callLog.resolveBundledModelDir.push(id);
      if (cfg.resolveBundledThrowsFor.has(id)) {
        throw new actual.EmbedderLoadError(`mocked-not-bundled:${id}`);
      }
      return `/mock/bundled/${id}`;
    },
  };
});

vi.mock("./nomic.js", () => ({
  createNomicHandle: async (opts: { modelDir: string; useCoreML: boolean; maxBatch: number }) => {
    callLog.createNomicHandle.push(opts);
    return {
      id: "nomic-text-v1.5" as const,
      dim: 768,
      maxBatch: opts.maxBatch,
      embed: async (texts: string[]) =>
        texts.map(() => new Float32Array(768)),
      dispose: async () => {},
    };
  },
}));

vi.mock("./snowflake.js", () => ({
  createSnowflakeHandle: async (opts: { modelDir: string; useCoreML: boolean; maxBatch: number }) => {
    callLog.createSnowflakeHandle.push(opts);
    return {
      id: "snowflake-arctic-embed-s" as const,
      dim: 384,
      maxBatch: opts.maxBatch,
      embed: async (texts: string[]) =>
        texts.map(() => new Float32Array(384)),
      dispose: async () => {},
    };
  },
  ensureSnowflakeWeights: async (opts: { cacheDir: string }) => {
    callLog.ensureSnowflakeWeights.push(opts);
    return cfg.ensureSnowflakeReturns || opts.cacheDir;
  },
  // SNOWFLAKE_DOWNLOAD not used by runtime.ts directly
  SNOWFLAKE_DOWNLOAD: { modelUrl: "", tokenizerUrl: "", configUrl: "" },
}));

import {
  load,
  pickEmbedderId,
  defaultModelId,
  LOW_RAM_THRESHOLD_BYTES,
  MAX_BATCH,
  EmbedderLoadError,
  isCoreMLEnabled,
} from "./runtime.js";

describe("runtime constants", () => {
  it("LOW_RAM_THRESHOLD_BYTES is 4 GiB", () => {
    expect(LOW_RAM_THRESHOLD_BYTES).toBe(4 * 1024 * 1024 * 1024);
  });

  it("MAX_BATCH is 64 (per spec)", () => {
    expect(MAX_BATCH).toBe(64);
  });

  it("re-exports EmbedderLoadError and isCoreMLEnabled", () => {
    expect(typeof EmbedderLoadError).toBe("function");
    expect(typeof isCoreMLEnabled).toBe("function");
  });
});

describe("pickEmbedderId", () => {
  it("returns nomic when free RAM is well above threshold", () => {
    expect(pickEmbedderId({ freeRamBytesOverride: 8 * 1024 * 1024 * 1024 })).toBe(
      "nomic-text-v1.5"
    );
  });

  it("returns snowflake when free RAM is below 4 GiB", () => {
    expect(pickEmbedderId({ freeRamBytesOverride: 2 * 1024 * 1024 * 1024 })).toBe(
      "snowflake-arctic-embed-s"
    );
  });

  it("honors opts.force regardless of RAM", () => {
    expect(
      pickEmbedderId({
        force: "nomic-text-v1.5",
        freeRamBytesOverride: 1,
      })
    ).toBe("nomic-text-v1.5");
    expect(
      pickEmbedderId({
        force: "snowflake-arctic-embed-s",
        freeRamBytesOverride: 999 * 1024 * 1024 * 1024,
      })
    ).toBe("snowflake-arctic-embed-s");
  });

  it("falls through to os.freemem() when no override given", () => {
    // os.freemem() is whatever the host actually has; all we can assert is
    // that pick returns one of the two valid ids.
    const id = pickEmbedderId();
    expect(["nomic-text-v1.5", "snowflake-arctic-embed-s"]).toContain(id);
  });
});

describe("defaultModelId", () => {
  it("returns whatever pickEmbedderId() returns at default settings", () => {
    expect(["nomic-text-v1.5", "snowflake-arctic-embed-s"]).toContain(defaultModelId());
  });

  it("matches pickEmbedderId() output", () => {
    // os.freemem() is constant within the same instant — assert agreement.
    const a = defaultModelId();
    const b = pickEmbedderId();
    expect(a).toBe(b);
  });
});

describe("load() dispatcher", () => {
  beforeEach(() => {
    callLog.resolveBundledModelDir = [];
    callLog.createNomicHandle = [];
    callLog.createSnowflakeHandle = [];
    callLog.ensureSnowflakeWeights = [];
    cfg.resolveBundledThrowsFor = new Set();
    cfg.ensureSnowflakeReturns = "";
  });

  it("with high RAM, loads nomic from the bundled path and returns a 768-dim handle", async () => {
    const h = await load({ freeRamBytesOverride: 8 * 1024 * 1024 * 1024 });
    expect(h.id).toBe("nomic-text-v1.5");
    expect(h.dim).toBe(768);
    expect(callLog.resolveBundledModelDir).toEqual(["nomic-text-v1.5"]);
    expect(callLog.createNomicHandle).toHaveLength(1);
    expect(callLog.createNomicHandle[0]!.modelDir).toBe("/mock/bundled/nomic-text-v1.5");
    expect(callLog.createNomicHandle[0]!.maxBatch).toBe(MAX_BATCH);
  });

  it("with low RAM, loads snowflake from the bundled path (preferred) and returns a 384-dim handle", async () => {
    const h = await load({ freeRamBytesOverride: 1 * 1024 * 1024 * 1024 });
    expect(h.id).toBe("snowflake-arctic-embed-s");
    expect(h.dim).toBe(384);
    expect(callLog.resolveBundledModelDir).toEqual(["snowflake-arctic-embed-s"]);
    expect(callLog.createSnowflakeHandle).toHaveLength(1);
    expect(callLog.createSnowflakeHandle[0]!.modelDir).toBe(
      "/mock/bundled/snowflake-arctic-embed-s"
    );
    // Did not need to download
    expect(callLog.ensureSnowflakeWeights).toHaveLength(0);
  });

  it("with low RAM AND snowflake not bundled, falls through to ensureSnowflakeWeights cache dir", async () => {
    cfg.resolveBundledThrowsFor.add("snowflake-arctic-embed-s");
    cfg.ensureSnowflakeReturns = "/cached/snowflake/path";
    const h = await load({ freeRamBytesOverride: 1 * 1024 * 1024 * 1024 });
    expect(h.id).toBe("snowflake-arctic-embed-s");
    expect(callLog.ensureSnowflakeWeights).toHaveLength(1);
    expect(callLog.ensureSnowflakeWeights[0]!.cacheDir).toContain(
      path.join(".lodestone", "models", "snowflake-arctic-embed-s")
    );
    expect(callLog.createSnowflakeHandle[0]!.modelDir).toBe("/cached/snowflake/path");
  });

  it("force='nomic-text-v1.5' picks nomic even on a low-RAM host", async () => {
    const h = await load({
      force: "nomic-text-v1.5",
      freeRamBytesOverride: 1 * 1024 * 1024 * 1024,
    });
    expect(h.id).toBe("nomic-text-v1.5");
    expect(callLog.createNomicHandle).toHaveLength(1);
  });

  it("force='snowflake-arctic-embed-s' picks snowflake even on a high-RAM host", async () => {
    const h = await load({
      force: "snowflake-arctic-embed-s",
      freeRamBytesOverride: 64 * 1024 * 1024 * 1024,
    });
    expect(h.id).toBe("snowflake-arctic-embed-s");
    expect(callLog.createSnowflakeHandle).toHaveLength(1);
  });

  it("modelPathOverride bypasses bundled-paths.resolveBundledModelDir for nomic", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "lodestone-rt-"));
    try {
      const h = await load({
        force: "nomic-text-v1.5",
        modelPathOverride: tmp,
      });
      expect(h.id).toBe("nomic-text-v1.5");
      expect(callLog.resolveBundledModelDir).toHaveLength(0);
      expect(callLog.createNomicHandle[0]!.modelDir).toBe(tmp);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("modelPathOverride bypasses both bundled-paths AND ensureSnowflakeWeights for snowflake", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "lodestone-rt-"));
    try {
      const h = await load({
        force: "snowflake-arctic-embed-s",
        modelPathOverride: tmp,
      });
      expect(h.id).toBe("snowflake-arctic-embed-s");
      expect(callLog.resolveBundledModelDir).toHaveLength(0);
      expect(callLog.ensureSnowflakeWeights).toHaveLength(0);
      expect(callLog.createSnowflakeHandle[0]!.modelDir).toBe(tmp);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returned handle.embed() returns one Float32Array per input (length matches dim)", async () => {
    const h = await load({ freeRamBytesOverride: 8 * 1024 * 1024 * 1024 });
    const out = await h.embed(["one", "two", "three"]);
    expect(out).toHaveLength(3);
    for (const v of out) expect(v.length).toBe(768);
  });

  it("dispose() on the returned handle is a no-op (idempotent)", async () => {
    const h = await load({ freeRamBytesOverride: 8 * 1024 * 1024 * 1024 });
    await h.dispose();
    await h.dispose();
  });
});

// SPDX-License-Identifier: Apache-2.0
// Tests for createNomicHandle. We mock the pipeline-loader so the test
// never touches @xenova/transformers or any ONNX session.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { SAMPLE_TEXTS, SAMPLE_BOM } from "./__fixtures__/sample-texts.js";

const fxState = {
  calls: [] as Array<{ texts: string[]; opts: unknown }>,
  disposed: 0,
  // What dim of vector each call returns. Default = NOMIC_DIM (768).
  dim: 768,
};

vi.mock("./pipeline-loader.js", () => {
  return {
    loadFeatureExtractor: async () => {
      const fx = async (texts: string[], opts: unknown) => {
        fxState.calls.push({ texts, opts });
        const data = new Float32Array(texts.length * fxState.dim);
        for (let i = 0; i < data.length; i += 1) data[i] = (i % 7) / 7;
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

import { createNomicHandle } from "./nomic.js";

describe("createNomicHandle", () => {
  beforeEach(() => {
    fxState.calls = [];
    fxState.disposed = 0;
    fxState.dim = 768;
  });

  it("returns a handle with id='nomic-text-v1.5', dim=768, configured maxBatch", async () => {
    const h = await createNomicHandle({
      modelDir: "/fake/nomic",
      useCoreML: false,
      maxBatch: 32,
    });
    expect(h.id).toBe("nomic-text-v1.5");
    expect(h.dim).toBe(768);
    expect(h.maxBatch).toBe(32);
  });

  it("embed() returns one Float32Array per input, each of length 768", async () => {
    const h = await createNomicHandle({
      modelDir: "/fake/nomic",
      useCoreML: false,
      maxBatch: 64,
    });
    const out = await h.embed([...SAMPLE_TEXTS]);
    expect(out).toHaveLength(SAMPLE_TEXTS.length);
    for (const v of out) {
      expect(v).toBeInstanceOf(Float32Array);
      expect(v.length).toBe(768);
    }
  });

  it("embed() passes pooling='mean', normalize=true to the underlying pipeline", async () => {
    const h = await createNomicHandle({
      modelDir: "/fake/nomic",
      useCoreML: false,
      maxBatch: 64,
    });
    await h.embed(["one", "two"]);
    expect(fxState.calls).toHaveLength(1);
    const opts = fxState.calls[0]!.opts as { pooling: string; normalize: boolean };
    expect(opts.pooling).toBe("mean");
    expect(opts.normalize).toBe(true);
  });

  it("embed() rejects on empty input batch", async () => {
    const h = await createNomicHandle({
      modelDir: "/fake/nomic",
      useCoreML: false,
      maxBatch: 64,
    });
    await expect(h.embed([])).rejects.toThrow(/at least one input/i);
  });

  it("embed() rejects when batch exceeds maxBatch", async () => {
    const h = await createNomicHandle({
      modelDir: "/fake/nomic",
      useCoreML: false,
      maxBatch: 4,
    });
    await expect(
      h.embed(["a", "b", "c", "d", "e"])
    ).rejects.toThrow(/max batch is 4/);
  });

  it("embed() handles UTF-8 BOM input without crashing", async () => {
    const h = await createNomicHandle({
      modelDir: "/fake/nomic",
      useCoreML: false,
      maxBatch: 4,
    });
    const out = await h.embed([SAMPLE_BOM]);
    expect(out).toHaveLength(1);
    expect(out[0]!.length).toBe(768);
  });

  it("dispose() is idempotent and only calls underlying dispose once", async () => {
    const h = await createNomicHandle({
      modelDir: "/fake/nomic",
      useCoreML: false,
      maxBatch: 4,
    });
    await h.dispose();
    await h.dispose();
    await h.dispose();
    expect(fxState.disposed).toBe(1);
  });

  it("embed() after dispose() throws", async () => {
    const h = await createNomicHandle({
      modelDir: "/fake/nomic",
      useCoreML: false,
      maxBatch: 4,
    });
    await h.dispose();
    await expect(h.embed(["x"])).rejects.toThrow(/disposed/);
  });

  it("embed() slices the contiguous buffer correctly: each row contains the right slice", async () => {
    // Use a deterministic dim where slicing is easy to verify.
    const h = await createNomicHandle({
      modelDir: "/fake/nomic",
      useCoreML: false,
      maxBatch: 8,
    });
    const out = await h.embed(["a", "b", "c"]);
    // Our mock fills data[i] = (i % 7) / 7. Row i should start at i*768.
    expect(out[0]![0]).toBeCloseTo(0 / 7);
    expect(out[1]![0]).toBeCloseTo((768 % 7) / 7);
    expect(out[2]![0]).toBeCloseTo((2 * 768 % 7) / 7);
  });
});

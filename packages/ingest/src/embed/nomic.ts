// SPDX-License-Identifier: Apache-2.0
// nomic-embed-text-v1.5 int8 loader. Default embedder. 768-dim, US-origin
// Apache 2.0, Matryoshka-truncatable, 8192-token context. ~150 MB bundled.
//
// Supply-chain: nomic-ai/* text models are approved per CMNDI mandate.
// `nomic-embed-code` is BANNED (Qwen2.5-Coder base, PRC origin); do not use.

import { loadFeatureExtractor, type FeatureExtractor } from "./pipeline-loader.js";
import type { EmbedderHandle, EmbedderId } from "./types.js";

const NOMIC_DIM = 768 as const;
const NOMIC_ID: EmbedderId = "nomic-text-v1.5";

export interface CreateNomicHandleOptions {
  modelDir: string;
  useCoreML: boolean;
  maxBatch: number;
}

/**
 * Build the EmbedderHandle for nomic. Validates batch shape, runs the
 * pipeline with mean-pooling + L2 normalization, slices the contiguous
 * Float32 buffer into per-input vectors.
 */
export async function createNomicHandle(
  opts: CreateNomicHandleOptions
): Promise<EmbedderHandle> {
  const fx: FeatureExtractor = await loadFeatureExtractor({
    modelDir: opts.modelDir,
    useCoreML: opts.useCoreML,
  });

  let disposed = false;

  return {
    id: NOMIC_ID,
    dim: NOMIC_DIM,
    maxBatch: opts.maxBatch,

    async embed(texts: string[]): Promise<Float32Array[]> {
      if (disposed) {
        throw new Error("nomic handle is disposed");
      }
      if (texts.length === 0) {
        throw new RangeError("embed() requires at least one input string");
      }
      if (texts.length > opts.maxBatch) {
        throw new RangeError(
          `embed() received ${texts.length} inputs; max batch is ${opts.maxBatch}`
        );
      }

      const result = await fx(texts, { pooling: "mean", normalize: true });
      // result.data is one contiguous Float32 buffer of [N, dim] row-major.
      // Slice into per-input vectors.
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += 1) {
        const start = i * NOMIC_DIM;
        out.push(result.data.slice(start, start + NOMIC_DIM));
      }
      return out;
    },

    async dispose(): Promise<void> {
      if (disposed) return; // idempotent
      disposed = true;
      try {
        await fx.dispose?.();
      } catch {
        // best-effort; releasing ONNX sessions can throw on some backends
      }
    },
  };
}

// SPDX-License-Identifier: Apache-2.0
// Thin abstraction over transformers.js's `pipeline("feature-extraction", ...)`
// so the model-specific loaders (nomic.ts, snowflake.ts) don't import the
// big lib directly and tests can mock this single seam.
//
// transformers.js (@xenova/transformers) is the JS port of HF Transformers
// with the ONNX backend. We use it for the feature-extraction pipeline,
// which loads the tokenizer + ONNX session, runs forward + mean-pools.

import {
  markCoreMLEnabled,
  markCoreMLUnavailable,
  preferredExecutionProviders,
} from "./coreml.js";

/**
 * Minimal shape of the feature-extraction pipeline we use. Returning
 * something with a `.data: Float32Array` and `.dims: number[]` is the
 * documented transformers.js Tensor surface.
 */
export interface FeatureExtractor {
  (texts: string[], opts: { pooling: "mean"; normalize: boolean }): Promise<{
    data: Float32Array;
    dims: number[];
  }>;
  dispose?: () => Promise<void>;
}

export interface LoadPipelineOptions {
  modelDir: string;
  /** When true, attempt CoreML EP first then fall back to CPU on failure. */
  useCoreML: boolean;
}

/**
 * Lazy import of `@xenova/transformers` so test environments can vi.mock()
 * this module without the big dep being on the resolution path. Production
 * resolves the real module on first call.
 */
async function importTransformers(): Promise<{
  pipeline: (
    task: string,
    model: string,
    opts: { quantized: boolean; local_files_only: boolean; cache_dir: string }
  ) => Promise<FeatureExtractor>;
  env: { allowLocalModels: boolean; localModelPath: string; backends?: { onnx?: { wasm?: { numThreads?: number } } } };
}> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import("@xenova/transformers");
  return { pipeline: mod.pipeline, env: mod.env };
}

/**
 * Load a transformers.js feature-extraction pipeline against a local model
 * directory. Tries CoreML first when requested, falls back to CPU on EP
 * failure. Records the resolved CoreML state via the coreml module so
 * `isCoreMLEnabled()` reports correctly.
 */
export async function loadFeatureExtractor(
  opts: LoadPipelineOptions
): Promise<FeatureExtractor> {
  const { pipeline, env } = await importTransformers();

  // Critical: keep transformers.js LOCAL-ONLY. No HF hub fetches. The
  // friend's privacy claim depends on this.
  env.allowLocalModels = true;
  env.localModelPath = opts.modelDir;

  const eps = opts.useCoreML
    ? preferredExecutionProviders()
    : (["cpu"] as const);

  for (const ep of eps) {
    try {
      const fx = await pipeline("feature-extraction", opts.modelDir, {
        quantized: true,
        local_files_only: true,
        cache_dir: opts.modelDir,
      });
      if (ep === "coreml") {
        markCoreMLEnabled();
      } else {
        markCoreMLUnavailable();
      }
      return fx;
    } catch (err) {
      // CoreML EP creation failed — try the next EP in the list.
      if (ep === "coreml") {
        markCoreMLUnavailable();
        continue;
      }
      throw err;
    }
  }

  throw new Error(
    `Failed to load feature-extraction pipeline at ${opts.modelDir} on any EP`
  );
}

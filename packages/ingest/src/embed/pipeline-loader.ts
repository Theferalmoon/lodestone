// SPDX-License-Identifier: Apache-2.0
// Thin abstraction over transformers.js's `pipeline("feature-extraction", ...)`
// so the model-specific loaders (nomic.ts, snowflake.ts) don't import the
// big lib directly and tests can mock this single seam.
//
// transformers.js (@xenova/transformers) is the JS port of HF Transformers
// with the ONNX backend. We use it for the feature-extraction pipeline,
// which loads the tokenizer + ONNX session, runs forward + mean-pools.

import path from "node:path";

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
  env: {
    allowLocalModels: boolean;
    /**
     * transformers.js defaults `allowRemoteModels = true` — meaning a
     * misconfigured local path silently falls through to a Hugging Face
     * download. Section 18 mandates we override that to `false` BEFORE the
     * first `pipeline()` call so the runtime cannot leak.
     */
    allowRemoteModels: boolean;
    localModelPath: string;
    /** transformers.js's HF cache dir; we pin it to the bundled model dir. */
    cacheDir?: string;
    /** transformers.js sets `useBrowserCache = true` by default; irrelevant in node but we pin it off. */
    useBrowserCache?: boolean;
    backends?: { onnx?: { wasm?: { numThreads?: number } } };
  };
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
  //
  // Section 18 / Codex impl-005 B2: `env.allowRemoteModels` MUST be set to
  // `false` BEFORE any `pipeline()` call. transformers.js ships with
  // `allowRemoteModels = true`; if we don't override it, a misconfigured
  // bundled-paths resolver silently falls through to a Hugging Face Hub
  // download — which violates the friend-product promise that "your code
  // never leaves your machine". `allowLocalModels` and `localModelPath`
  // alone are NOT sufficient — `allowRemoteModels` is the kill switch.
  // transformers.js convention:
  //   env.localModelPath = the BASE dir containing model subdirs
  //   pipeline(task, modelId, ...) where modelId is the SUBDIR name
  // So if our bundled model lives at /a/b/models/nomic/, we set
  // localModelPath = "/a/b/models" and pass "nomic" as the model id.
  // Passing the full absolute path as both was a v0.1.0 dogfood bug —
  // transformers.js double-prepended the localModelPath to the modelId.
  const modelParent = path.dirname(opts.modelDir);
  const modelId = path.basename(opts.modelDir);

  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.localModelPath = modelParent;
  // Pin cache + disable browser cache as defense in depth — even if a future
  // transformers.js release adds a third resolver path, every fallback will
  // resolve under our model dir, never `~/.cache/huggingface/`.
  env.cacheDir = modelParent;
  env.useBrowserCache = false;

  const eps = opts.useCoreML
    ? preferredExecutionProviders()
    : (["cpu"] as const);

  for (const ep of eps) {
    try {
      const fx = await pipeline("feature-extraction", modelId, {
        quantized: true,
        local_files_only: true,
        cache_dir: modelParent,
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

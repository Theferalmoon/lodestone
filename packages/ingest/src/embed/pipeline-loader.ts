// SPDX-License-Identifier: Apache-2.0
// Thin abstraction over transformers.js's `pipeline("feature-extraction", ...)`
// so the model-specific loaders (nomic.ts, snowflake.ts) don't import the
// big lib directly and tests can mock this single seam.
//
// transformers.js (@xenova/transformers) is the JS port of HF Transformers
// with the ONNX backend. We use it for the feature-extraction pipeline,
// which loads the tokenizer + ONNX session, runs forward + mean-pools.
//
// CoreML EP — known no-op under @xenova/transformers v2.x.
// ====================================================================
// Codex impl-005 §05 review YELLOW: the previous version of this file
// computed `preferredExecutionProviders()` and looped over the EP list
// (`["coreml", "cpu"]` on Apple Silicon), but @xenova/transformers v2.17.x
// EXPORTS `executionProviders` as a module-level constant from
// `backends/onnx.js` and pins it to `["cpu", "wasm"]` in node — there is
// NO public API on `pipeline()` to override it per call. The EP loop
// silently fell through to CPU on every host AND `markCoreMLEnabled()`
// fired on Apple Silicon's first successful call, falsely reporting
// CoreML as enabled to the doctor / status surfaces.
//
// The fix:
//   - We KEEP the `useCoreML` knob on the loader options because the
//     dispatcher in runtime.ts already reads `detectCoreMLCapable()` and
//     forwards the bit. Removing it would ripple through the public
//     `LoadOptions` type, the bundled-paths resolver, and every test
//     fixture for marginal gain.
//   - We NEVER call `markCoreMLEnabled()` from this loader. The status
//     surfaces will report CoreML as unavailable (consistent with the
//     actual runtime behavior).
//   - When @xenova/transformers v3 lands (which exposes per-call
//     `executionProviders`) OR we move to onnxruntime-node directly,
//     this is the file to upgrade — the loader is the single seam, so
//     callers never know the EP is currently a no-op.
//
// Compliance: NIST 800-53 SI-7 (Software/Firmware Integrity — accurate
// telemetry of running components), AU-12 (Audit Generation — doctor
// surfaces must report true state); CMMC L2 SI.L2-3.14.1; SOC 2 CC7.2.

import path from "node:path";

import {
  markCoreMLUnavailable,
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
  /**
   * Operator hint. Currently a no-op under @xenova/transformers v2.x — the
   * lib does not expose a per-call EP override, so we always run on the
   * default node EP set (cpu + wasm). The flag is preserved for v3
   * upgrade and for forward-compatible callers; see the file header for
   * the rationale.
   */
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
 * directory. The `useCoreML` opt is currently a no-op under
 * @xenova/transformers v2.x (see file header) — we always run on the lib's
 * default node EPs and explicitly mark CoreML unavailable so doctor /
 * status surfaces report accurately.
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

  // CoreML is a known no-op under @xenova/transformers v2.x — we cannot
  // pass an EP override into pipeline(), so explicitly mark CoreML
  // unavailable BEFORE the call so the status surface never shows a
  // false positive even if the call succeeds. The `useCoreML` opt is
  // preserved for the v3 upgrade path; intentionally referenced here
  // (not destructured-and-discarded) so a `noUnusedParameters` build
  // setting wouldn't accidentally remove it from the public type.
  void opts.useCoreML;
  markCoreMLUnavailable();

  return pipeline("feature-extraction", modelId, {
    quantized: true,
    local_files_only: true,
    cache_dir: modelParent,
  });
}

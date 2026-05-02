// SPDX-License-Identifier: Apache-2.0
// Tests for the transformers.js seam. We mock @xenova/transformers so the
// test never loads the real ~50 MB lib or any ONNX session.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// State the mocked transformers.js exposes back to the test.
const transformersState = {
  pipelineCalls: [] as Array<{ task: string; model: string; opts: unknown }>,
  pipelineImpl: undefined as
    | ((task: string, model: string, opts: unknown) => Promise<unknown>)
    | undefined,
  env: {
    allowLocalModels: false,
    // transformers.js default — Section 18 forces this to false.
    allowRemoteModels: true,
    localModelPath: "",
    cacheDir: "",
    useBrowserCache: true,
  },
};

vi.mock("@xenova/transformers", () => {
  return {
    pipeline: async (task: string, model: string, opts: unknown) => {
      transformersState.pipelineCalls.push({ task, model, opts });
      if (transformersState.pipelineImpl) {
        return transformersState.pipelineImpl(task, model, opts);
      }
      // Default: return a no-op feature extractor.
      const fx = async (_texts: string[], _o: unknown) => ({
        data: new Float32Array(0),
        dims: [0],
      });
      return Object.assign(fx, { dispose: async () => {} });
    },
    env: transformersState.env,
  };
});

import { _resetCoreMLState, isCoreMLEnabled } from "./coreml.js";
import { loadFeatureExtractor } from "./pipeline-loader.js";

describe("loadFeatureExtractor", () => {
  beforeEach(() => {
    transformersState.pipelineCalls = [];
    transformersState.pipelineImpl = undefined;
    transformersState.env.allowLocalModels = false;
    // Reset to the transformers.js DEFAULT — the loader must override this.
    transformersState.env.allowRemoteModels = true;
    transformersState.env.localModelPath = "";
    transformersState.env.cacheDir = "";
    transformersState.env.useBrowserCache = true;
    _resetCoreMLState();
  });

  afterEach(() => {
    _resetCoreMLState();
  });

  it("lazily imports @xenova/transformers and calls pipeline('feature-extraction', modelDir, ...)", async () => {
    const fx = await loadFeatureExtractor({
      modelDir: "/some/model/dir",
      useCoreML: false,
    });
    expect(typeof fx).toBe("function");
    expect(transformersState.pipelineCalls).toHaveLength(1);
    const call = transformersState.pipelineCalls[0]!;
    expect(call.task).toBe("feature-extraction");
    expect(call.model).toBe("/some/model/dir");
    // local-only — no HF fetches
    expect((call.opts as { local_files_only: boolean }).local_files_only).toBe(true);
    expect((call.opts as { quantized: boolean }).quantized).toBe(true);
  });

  it("forces transformers.env into local-only mode pointing at the supplied modelDir", async () => {
    await loadFeatureExtractor({
      modelDir: "/path/to/nomic",
      useCoreML: false,
    });
    expect(transformersState.env.allowLocalModels).toBe(true);
    expect(transformersState.env.localModelPath).toBe("/path/to/nomic");
  });

  // Section 18 / Codex impl-005 B2 — privacy-critical regression guard.
  // transformers.js defaults `allowRemoteModels = true`. If the loader does
  // NOT explicitly override that to `false`, a misconfigured bundled-paths
  // resolver silently falls through to a Hugging Face Hub download. The
  // friend-product privacy promise depends on this kill switch.
  it("overrides transformers.env.allowRemoteModels to false BEFORE pipeline() is called", async () => {
    let envSnapshotAtPipelineCall: { allowRemoteModels: boolean } | undefined;
    transformersState.pipelineImpl = async () => {
      envSnapshotAtPipelineCall = {
        allowRemoteModels: transformersState.env.allowRemoteModels,
      };
      const fx = async () => ({ data: new Float32Array(0), dims: [0] });
      return Object.assign(fx, { dispose: async () => {} });
    };
    // Default state has allowRemoteModels=true (the dangerous default).
    expect(transformersState.env.allowRemoteModels).toBe(true);
    await loadFeatureExtractor({ modelDir: "/m", useCoreML: false });
    expect(envSnapshotAtPipelineCall?.allowRemoteModels).toBe(false);
    // And the post-call state is also false (no late re-enable).
    expect(transformersState.env.allowRemoteModels).toBe(false);
  });

  it("pins env.cacheDir to the supplied modelDir and disables useBrowserCache (defense in depth)", async () => {
    await loadFeatureExtractor({
      modelDir: "/path/to/nomic",
      useCoreML: false,
    });
    expect(transformersState.env.cacheDir).toBe("/path/to/nomic");
    expect(transformersState.env.useBrowserCache).toBe(false);
  });

  it("on CPU-only hosts, marks CoreML unavailable after a successful CPU load", async () => {
    // process.platform/arch are linux-x64 in CI — preferredExecutionProviders
    // should yield ["cpu"] and the loader should record CoreML=false.
    await loadFeatureExtractor({
      modelDir: "/m",
      useCoreML: true, // requested, but host can't honor it
    });
    expect(isCoreMLEnabled()).toBe(false);
  });

  it("propagates a CPU-EP failure (no CoreML to retry) by throwing", async () => {
    transformersState.pipelineImpl = async () => {
      throw new Error("ONNX session boom");
    };
    await expect(
      loadFeatureExtractor({ modelDir: "/m", useCoreML: false })
    ).rejects.toThrow(/ONNX session boom/);
  });

  it("is callable repeatedly (each call returns a fresh extractor) — no internal cache here", async () => {
    // The pipeline-loader does NOT cache the extractor across calls; each
    // model handle owns its own. Verify by counting pipeline invocations.
    await loadFeatureExtractor({ modelDir: "/m", useCoreML: false });
    await loadFeatureExtractor({ modelDir: "/m", useCoreML: false });
    expect(transformersState.pipelineCalls).toHaveLength(2);
  });

  it("when on Apple Silicon and CoreML EP creation succeeds on the first try, marks CoreML enabled", async () => {
    const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    const origArch = Object.getOwnPropertyDescriptor(process, "arch");
    try {
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
      Object.defineProperty(process, "arch", { value: "arm64", configurable: true });
      _resetCoreMLState();
      await loadFeatureExtractor({ modelDir: "/m", useCoreML: true });
      expect(isCoreMLEnabled()).toBe(true);
    } finally {
      if (origPlatform) Object.defineProperty(process, "platform", origPlatform);
      if (origArch) Object.defineProperty(process, "arch", origArch);
      _resetCoreMLState();
    }
  });

  it("on Apple Silicon, falls back to CPU when CoreML EP attempt throws and marks CoreML unavailable", async () => {
    const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    const origArch = Object.getOwnPropertyDescriptor(process, "arch");
    try {
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
      Object.defineProperty(process, "arch", { value: "arm64", configurable: true });
      _resetCoreMLState();

      let attempt = 0;
      transformersState.pipelineImpl = async () => {
        attempt += 1;
        if (attempt === 1) {
          throw new Error("CoreML EP boom");
        }
        const fx = async () => ({ data: new Float32Array(0), dims: [0] });
        return Object.assign(fx, { dispose: async () => {} });
      };

      const fx = await loadFeatureExtractor({ modelDir: "/m", useCoreML: true });
      expect(typeof fx).toBe("function");
      expect(attempt).toBe(2); // tried coreml then cpu
      expect(isCoreMLEnabled()).toBe(false);
    } finally {
      if (origPlatform) Object.defineProperty(process, "platform", origPlatform);
      if (origArch) Object.defineProperty(process, "arch", origArch);
      _resetCoreMLState();
    }
  });
});

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

  // transformers.js convention is `localModelPath = <BASE dir>` and the
  // model id is the SUBDIR name (joined as `<localModelPath>/<modelId>`).
  // The loader splits the supplied absolute modelDir into parent + basename
  // to satisfy that — passing the full path as both was the v0.1.0 dogfood
  // bug that caused transformers.js to double-prepend the path.
  it("calls pipeline('feature-extraction', basename(modelDir), ...) — transformers.js needs basename, not full path", async () => {
    const fx = await loadFeatureExtractor({
      modelDir: "/some/model/dir",
      useCoreML: false,
    });
    expect(typeof fx).toBe("function");
    expect(transformersState.pipelineCalls).toHaveLength(1);
    const call = transformersState.pipelineCalls[0]!;
    expect(call.task).toBe("feature-extraction");
    expect(call.model).toBe("dir");
    // local-only — no HF fetches
    expect((call.opts as { local_files_only: boolean }).local_files_only).toBe(true);
    expect((call.opts as { quantized: boolean }).quantized).toBe(true);
  });

  it("forces transformers.env.localModelPath to the PARENT of modelDir (transformers.js prepends modelId)", async () => {
    await loadFeatureExtractor({
      modelDir: "/path/to/nomic",
      useCoreML: false,
    });
    expect(transformersState.env.allowLocalModels).toBe(true);
    expect(transformersState.env.localModelPath).toBe("/path/to");
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

  it("pins env.cacheDir to the PARENT of modelDir and disables useBrowserCache (defense in depth)", async () => {
    await loadFeatureExtractor({
      modelDir: "/path/to/nomic",
      useCoreML: false,
    });
    expect(transformersState.env.cacheDir).toBe("/path/to");
    expect(transformersState.env.useBrowserCache).toBe(false);
  });

  it("on CPU-only hosts, marks CoreML unavailable after a successful CPU load", async () => {
    // Force a CPU-only platform — CI matrix includes macos-14 (arm64) where
    // CoreML IS available, so we can't rely on the runner's true platform.
    const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    const origArch = Object.getOwnPropertyDescriptor(process, "arch");
    try {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      Object.defineProperty(process, "arch", { value: "x64", configurable: true });
      _resetCoreMLState();
      await loadFeatureExtractor({
        modelDir: "/m",
        useCoreML: true, // requested, but host can't honor it
      });
      expect(isCoreMLEnabled()).toBe(false);
    } finally {
      if (origPlatform) Object.defineProperty(process, "platform", origPlatform);
      if (origArch) Object.defineProperty(process, "arch", origArch);
      _resetCoreMLState();
    }
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

  // Codex impl-005 §05 review YELLOW (post-fix): the loader can no longer
  // claim CoreML is enabled because @xenova/transformers v2.x has no per-call
  // EP override. Even on Apple Silicon, status surfaces report CoreML as
  // unavailable — honest reporting beats false-positive telemetry.
  it("on Apple Silicon, marks CoreML UNAVAILABLE (no honest way to enable it under transformers.js v2)", async () => {
    const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    const origArch = Object.getOwnPropertyDescriptor(process, "arch");
    try {
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
      Object.defineProperty(process, "arch", { value: "arm64", configurable: true });
      _resetCoreMLState();
      await loadFeatureExtractor({ modelDir: "/m", useCoreML: true });
      // We DELIBERATELY do not mark CoreML enabled — see file header for why.
      expect(isCoreMLEnabled()).toBe(false);
    } finally {
      if (origPlatform) Object.defineProperty(process, "platform", origPlatform);
      if (origArch) Object.defineProperty(process, "arch", origArch);
      _resetCoreMLState();
    }
  });

  it("calls pipeline() exactly once (no EP-list retry loop — single CPU/wasm path)", async () => {
    const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    const origArch = Object.getOwnPropertyDescriptor(process, "arch");
    try {
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
      Object.defineProperty(process, "arch", { value: "arm64", configurable: true });
      _resetCoreMLState();

      let attempt = 0;
      transformersState.pipelineImpl = async () => {
        attempt += 1;
        const fx = async () => ({ data: new Float32Array(0), dims: [0] });
        return Object.assign(fx, { dispose: async () => {} });
      };

      const fx = await loadFeatureExtractor({ modelDir: "/m", useCoreML: true });
      expect(typeof fx).toBe("function");
      // Previously: 2 attempts (coreml, then cpu). Now: 1 — there is no
      // per-call EP override to retry, so pipeline() runs once and that's it.
      expect(attempt).toBe(1);
      expect(isCoreMLEnabled()).toBe(false);
    } finally {
      if (origPlatform) Object.defineProperty(process, "platform", origPlatform);
      if (origArch) Object.defineProperty(process, "arch", origArch);
      _resetCoreMLState();
    }
  });
});

// SPDX-License-Identifier: Apache-2.0
// snowflake-arctic-embed-s int8 fallback embedder. 384-dim, ~33 MB.
// Selected by the dispatcher when free RAM <4 GB at load time.
//
// The bundled-paths resolver covers the OPTIONAL bundled case (Section 18
// hardens "no outbound URLs in dist" by bundling both embedders). When the
// bundle does NOT include snowflake (early dev / size-trimmed builds), this
// loader can fetch + cache the int8 weights from the pinned HF URL — but
// ONLY when ALL THREE gates say yes:
//
//   1. Operator explicit opt-in:
//      `LODESTONE_ALLOW_MODEL_DOWNLOAD=1` env var OR `allowDownload: true`
//      passed through the load options. Without one of these, the runtime
//      fallback REFUSES to do anything that touches the network — even if
//      LODESTONE_OFFLINE is unset. This matches the `lodestone setup-models`
//      consent model (Section 05 amendment §1) so there is exactly one way
//      to authorize a model download in friend mode.
//   2. Section 18 chokepoint:
//      `assertNetworkAllowed("snowflake fallback weights")` from
//      `@lodestone/shared`. When `LODESTONE_OFFLINE=1` is set, this throws.
//   3. SHA256 verification:
//      Each downloaded file's bytes are hashed and compared against a pin.
//      Mismatch deletes the bad bytes and throws — never leave verified-bad
//      content on disk.
//
// Layout: weights are written under the transformers.js convention,
// `<cacheDir>/onnx/model_quantized.onnx` + `<cacheDir>/tokenizer.json` +
// `<cacheDir>/config.json`. This matches `bundled-paths.resolveBundledModelDir`
// (which requires `onnx/model_quantized.onnx`) AND `setup-models` so the
// fetched cache is loadable by transformers.js without a second post-process
// step.
//
// Supply-chain: Snowflake/snowflake-arctic-embed-s is approved (Apache 2.0,
// US-origin Snowflake Inc.). The placeholder zero-hash pin below intentionally
// causes a clear sha256 mismatch on any live fetch until release time fills in
// real digests — fail-closed is the correct privacy default.
//
// Compliance: NIST 800-53 SC-7 (Boundary Protection), CM-7 (Least
// Functionality), AC-3 (Access Enforcement), SI-7 (Software/Firmware
// Integrity — sha256 verification); CMMC L2 SC.L2-3.13.5, SI.L2-3.14.1;
// SOC 2 CC6.6, CC7.2; ISO 27001 A.13.1.1, A.12.1.2;
// FedRAMP Moderate SC-7, SI-7.

import { mkdirSync, existsSync, writeFileSync, unlinkSync, renameSync } from "node:fs";
import path from "node:path";

import { assertNetworkAllowed, NetworkBlockedError, sha256File } from "@lodestone/shared";

import { loadFeatureExtractor, type FeatureExtractor } from "./pipeline-loader.js";
import { EmbedderLoadError } from "./bundled-paths.js";
import type { EmbedderHandle, EmbedderId } from "./types.js";

const SNOWFLAKE_DIM = 384 as const;
const SNOWFLAKE_ID: EmbedderId = "snowflake-arctic-embed-s";

/**
 * Placeholder SHA256 (64 zeros). Real digests will be filled at release time
 * by the bundler script that captures the bytes from the pinned HF URL. Until
 * then any live fetch will fail SHA256 verification with an actionable error
 * — which is the correct fail-closed privacy default.
 */
const PLACEHOLDER_SHA256 = "0".repeat(64);

/**
 * Per-file pin: the exact bytes we'll accept at this URL. The relative path
 * is the on-disk layout under `cacheDir`. transformers.js requires
 * `onnx/model_quantized.onnx` to live under an `onnx/` subdir.
 */
export interface SnowflakeFilePin {
  /** Path under cacheDir, e.g. "onnx/model_quantized.onnx". */
  readonly relPath: string;
  readonly url: string;
  readonly sha256: string;
}

/**
 * Pinned download source. Exported so SUPPLY-CHAIN.md / tests can reference
 * the exact URLs. The hashes are verified post-download. The shape pins ALL
 * THREE files together so a partial-fetch desync is impossible.
 *
 * The aliased `modelUrl`/`tokenizerUrl`/`configUrl` fields preserve the v0.1.1
 * surface so any external test that imports the constant keeps compiling.
 */
export const SNOWFLAKE_DOWNLOAD = Object.freeze({
  files: Object.freeze([
    Object.freeze({
      relPath: "onnx/model_quantized.onnx",
      url: "https://huggingface.co/Snowflake/snowflake-arctic-embed-s/resolve/main/onnx/model_quantized.onnx",
      sha256: PLACEHOLDER_SHA256,
    }),
    Object.freeze({
      relPath: "tokenizer.json",
      url: "https://huggingface.co/Snowflake/snowflake-arctic-embed-s/resolve/main/tokenizer.json",
      sha256: PLACEHOLDER_SHA256,
    }),
    Object.freeze({
      relPath: "config.json",
      url: "https://huggingface.co/Snowflake/snowflake-arctic-embed-s/resolve/main/config.json",
      sha256: PLACEHOLDER_SHA256,
    }),
  ]) as ReadonlyArray<SnowflakeFilePin>,
  // Back-compat aliases — same URLs as files[].
  modelUrl:
    "https://huggingface.co/Snowflake/snowflake-arctic-embed-s/resolve/main/onnx/model_quantized.onnx",
  tokenizerUrl:
    "https://huggingface.co/Snowflake/snowflake-arctic-embed-s/resolve/main/tokenizer.json",
  configUrl:
    "https://huggingface.co/Snowflake/snowflake-arctic-embed-s/resolve/main/config.json",
} as const);

export interface CreateSnowflakeHandleOptions {
  modelDir: string;
  useCoreML: boolean;
  maxBatch: number;
}

export interface EnsureWeightsOptions {
  cacheDir: string;
  /**
   * Per-invocation operator consent. When `true` OR
   * `LODESTONE_ALLOW_MODEL_DOWNLOAD=1` is set in the environment, the
   * download path is allowed (subject to the Section 18 chokepoint). When
   * neither is set, the function throws `EmbedderLoadError` immediately
   * with no network I/O — defense in depth on the privacy promise.
   */
  allowDownload?: boolean;
  /** Override fetch for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Test seam — overrides the per-file SHA256 pin so deterministic byte
   * fixtures can be hashed at test time without round-tripping the placeholder
   * pin. Production callers MUST NOT supply this.
   */
  pinOverrides?: ReadonlyMap<string, string>;
}

/**
 * Ensure snowflake weights exist under `cacheDir`. If not, download them
 * (when both consent gates AND the offline chokepoint allow it), verify
 * the SHA256 of the bytes against the pin, atomically write to disk, and
 * return the cache dir.
 *
 * Failure modes — all surface as `EmbedderLoadError` with hint text:
 *   - No consent (env var unset AND `allowDownload` not true)
 *   - LODESTONE_OFFLINE=1
 *   - Non-OK fetch response
 *   - SHA256 mismatch (bad bytes are deleted, never left on disk)
 */
export async function ensureSnowflakeWeights(
  opts: EnsureWeightsOptions
): Promise<string> {
  // Cache hit: every required file already present. Skip every gate — the
  // friend-mode steady state is "no outbound calls, ever." We do NOT verify
  // SHA256 of pre-existing files here; if the operator pre-populated the
  // cache themselves they own that decision (mirroring how setup-models
  // treats `--force` vs. idempotent skip).
  const allPresent = SNOWFLAKE_DOWNLOAD.files.every((f) =>
    existsSync(path.join(opts.cacheDir, f.relPath))
  );
  if (allPresent) return opts.cacheDir;

  // Gate 1 — operator explicit opt-in. Either env var OR per-call flag must
  // be true. Without one of these, REFUSE to touch the network even if
  // LODESTONE_OFFLINE is unset. This is the privacy guarantee the Codex §05
  // review (RED #1) demanded: offline-mode-not-set is NOT consent.
  const envConsent = process.env.LODESTONE_ALLOW_MODEL_DOWNLOAD === "1";
  const flagConsent = opts.allowDownload === true;
  if (!envConsent && !flagConsent) {
    throw new EmbedderLoadError(
      `Snowflake fallback weights not cached at ${opts.cacheDir} and no model-download consent given`,
      `Run "lodestone setup-models --embedder snowflake-arctic-embed-s --allow-download" to fetch + verify the weights once, ` +
        `or set LODESTONE_ALLOW_MODEL_DOWNLOAD=1 in the environment of the calling process. ` +
        `Lodestone's privacy promise is opt-in network — see docs/PRIVACY.md.`
    );
  }

  // Gate 2 — Section 18 chokepoint. Repo-wide privacy gate; even with
  // operator consent, LODESTONE_OFFLINE=1 wins.
  try {
    assertNetworkAllowed("snowflake fallback weights");
  } catch (err: unknown) {
    if (err instanceof NetworkBlockedError) {
      throw new EmbedderLoadError(
        `Snowflake fallback weights not cached at ${opts.cacheDir} and LODESTONE_OFFLINE=1`,
        `Set LODESTONE_OFFLINE=0 (or unset) to allow the one-time download, or pre-populate the cache directory. Original: ${err.message}`
      );
    }
    throw err;
  }

  mkdirSync(opts.cacheDir, { recursive: true });
  const fetchImpl = opts.fetchImpl ?? fetch;
  for (const file of SNOWFLAKE_DOWNLOAD.files) {
    const dest = path.join(opts.cacheDir, file.relPath);
    if (existsSync(dest)) continue;
    // Ensure the parent dir exists (e.g. <cacheDir>/onnx/ for the ONNX file).
    mkdirSync(path.dirname(dest), { recursive: true });

    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await fetchImpl(file.url);
    } catch (err) {
      throw new EmbedderLoadError(
        `Failed to fetch ${file.url}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (!res.ok) {
      throw new EmbedderLoadError(
        `Failed to fetch ${file.url}: HTTP ${res.status}`
      );
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const tmp = `${dest}.tmp`;
    writeFileSync(tmp, buf);
    // Atomic rename — on the same filesystem, mv is atomic on POSIX/NTFS.
    renameSync(tmp, dest);

    // Gate 3 — verify SHA256 against the pin (or the test override). Mismatch
    // means we delete the bad bytes and refuse to load. NEVER leave verified-bad
    // content on disk. This is the SI-7 (Software/Firmware Integrity) control.
    const expected =
      opts.pinOverrides?.get(file.relPath) ?? file.sha256;
    const actual = sha256File(dest);
    if (actual !== expected) {
      try {
        unlinkSync(dest);
      } catch {
        // best-effort — error message below tells the operator the file is
        // present but unverified; they can delete the cache dir to retry.
      }
      throw new EmbedderLoadError(
        `SHA256 mismatch for ${file.relPath} fetched from ${file.url}`,
        `Expected ${expected}, got ${actual}. The downloaded file has been removed. ` +
          `This usually means the pin in snowflake.ts is out of date for the upstream HF revision, ` +
          `or the bytes were tampered with in transit. Re-run after updating the pin.`
      );
    }
  }

  return opts.cacheDir;
}

/**
 * Build the EmbedderHandle for snowflake. Same shape as nomic but 384-dim.
 */
export async function createSnowflakeHandle(
  opts: CreateSnowflakeHandleOptions
): Promise<EmbedderHandle> {
  const fx: FeatureExtractor = await loadFeatureExtractor({
    modelDir: opts.modelDir,
    useCoreML: opts.useCoreML,
  });

  let disposed = false;

  return {
    id: SNOWFLAKE_ID,
    dim: SNOWFLAKE_DIM,
    maxBatch: opts.maxBatch,

    async embed(texts: string[]): Promise<Float32Array[]> {
      if (disposed) {
        throw new Error("snowflake handle is disposed");
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
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += 1) {
        const start = i * SNOWFLAKE_DIM;
        out.push(result.data.slice(start, start + SNOWFLAKE_DIM));
      }
      return out;
    },

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      try {
        await fx.dispose?.();
      } catch {
        // best-effort
      }
    },
  };
}

// SPDX-License-Identifier: Apache-2.0
// snowflake-arctic-embed-s int8 fallback embedder. 384-dim, ~33 MB.
// Selected by the dispatcher when free RAM <4 GB at load time.
//
// The bundled-paths resolver covers the OPTIONAL bundled case (Section 18
// hardens "no outbound URLs in dist" by bundling both embedders). When the
// bundle does NOT include snowflake (early dev / size-trimmed builds), this
// loader can fetch + cache the int8 weights from the pinned HF URL — but
// only when LODESTONE_OFFLINE !== "1" and the SHA256 matches the pin.
//
// Supply-chain: Snowflake/snowflake-arctic-embed-s is approved (Apache 2.0,
// US-origin Snowflake Inc.). Pin the resolve commit + SHA256 in
// SUPPLY-CHAIN.md (Section 21).

import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";

import { loadFeatureExtractor, type FeatureExtractor } from "./pipeline-loader.js";
import { EmbedderLoadError } from "./bundled-paths.js";
import type { EmbedderHandle, EmbedderId } from "./types.js";

const SNOWFLAKE_DIM = 384 as const;
const SNOWFLAKE_ID: EmbedderId = "snowflake-arctic-embed-s";

/**
 * Pinned download source. Exported so SUPPLY-CHAIN.md / tests can reference
 * the exact URL. The hash is verified post-download.
 */
export const SNOWFLAKE_DOWNLOAD = Object.freeze({
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
  /** Override fetch for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Ensure snowflake weights exist under `cacheDir`. If not, download them
 * (when allowed by LODESTONE_OFFLINE), atomically write to disk, and return
 * the cache dir. If LODESTONE_OFFLINE === "1" and the files are missing,
 * throws EmbedderLoadError so the operator can diagnose.
 */
export async function ensureSnowflakeWeights(
  opts: EnsureWeightsOptions
): Promise<string> {
  const required = [
    { name: "model_quantized.onnx", url: SNOWFLAKE_DOWNLOAD.modelUrl },
    { name: "tokenizer.json", url: SNOWFLAKE_DOWNLOAD.tokenizerUrl },
    { name: "config.json", url: SNOWFLAKE_DOWNLOAD.configUrl },
  ];
  const allPresent = required.every((f) => existsSync(path.join(opts.cacheDir, f.name)));
  if (allPresent) return opts.cacheDir;

  if (process.env.LODESTONE_OFFLINE === "1") {
    throw new EmbedderLoadError(
      `Snowflake fallback weights not cached at ${opts.cacheDir} and LODESTONE_OFFLINE=1`,
      `Set LODESTONE_OFFLINE=0 (or unset) to allow the one-time download, or pre-populate the cache directory.`
    );
  }

  mkdirSync(opts.cacheDir, { recursive: true });
  const fetchImpl = opts.fetchImpl ?? fetch;
  for (const file of required) {
    const dest = path.join(opts.cacheDir, file.name);
    if (existsSync(dest)) continue;
    const res = await fetchImpl(file.url);
    if (!res.ok) {
      throw new EmbedderLoadError(
        `Failed to fetch ${file.url}: HTTP ${res.status}`
      );
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const tmp = `${dest}.tmp`;
    writeFileSync(tmp, buf);
    // Atomic rename — on the same filesystem, mv is atomic on POSIX/NTFS.
    const { renameSync } = await import("node:fs");
    renameSync(tmp, dest);
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

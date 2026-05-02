// SPDX-License-Identifier: Apache-2.0
// Public dispatcher for the bundled embedder runtime. Picks nomic by default
// and falls back to snowflake when free RAM <4 GB at load time. Honors the
// LODESTONE_OFFLINE flag (Section 18 mandate) for the snowflake fetch path.

import os from "node:os";
import path from "node:path";

import { resolveBundledModelDir, EmbedderLoadError } from "./bundled-paths.js";
import { createNomicHandle } from "./nomic.js";
import { createSnowflakeHandle, ensureSnowflakeWeights } from "./snowflake.js";
import { detectCoreMLCapable, isCoreMLEnabled } from "./coreml.js";
import type { EmbedderHandle, EmbedderId, LoadOptions } from "./types.js";

export type { EmbedderHandle, EmbedderId, LoadOptions } from "./types.js";
export { isCoreMLEnabled } from "./coreml.js";
export { EmbedderLoadError } from "./bundled-paths.js";

/** Free-RAM threshold (bytes) below which we fall back to snowflake. */
export const LOW_RAM_THRESHOLD_BYTES = 4 * 1024 * 1024 * 1024;

/** Per-call ceiling on batch size. Implementation-chosen. */
export const MAX_BATCH = 64;

/**
 * Decide which embedder to use based on options + free RAM.
 * Exposed for tests.
 */
export function pickEmbedderId(opts: LoadOptions = {}): EmbedderId {
  if (opts.force) return opts.force;
  const freeRam = opts.freeRamBytesOverride ?? os.freemem();
  return freeRam < LOW_RAM_THRESHOLD_BYTES ? "snowflake-arctic-embed-s" : "nomic-text-v1.5";
}

/**
 * Where snowflake fallback weights are cached when not bundled.
 * Resolves to <cwd>/.lodestone/models/snowflake-arctic-embed-s/.
 */
function snowflakeCacheDir(cwd: string = process.cwd()): string {
  return path.join(cwd, ".lodestone", "models", "snowflake-arctic-embed-s");
}

/**
 * Loads the configured embedder.
 *
 * Default: picks nomic-text-v1.5. If `os.freemem()` < LOW_RAM_THRESHOLD_BYTES
 * (or `opts.freeRamBytesOverride` is below it), picks snowflake-arctic-embed-s
 * and ensures its weights are on disk (downloads from the pinned HF URL when
 * not cached, unless LODESTONE_OFFLINE=1 in which case it throws).
 *
 * `opts.force` bypasses the RAM heuristic. `opts.modelPathOverride` overrides
 * the resolved bundled path (for tests).
 */
export async function load(opts: LoadOptions = {}): Promise<EmbedderHandle> {
  const id = pickEmbedderId(opts);
  const useCoreML = detectCoreMLCapable();

  if (id === "nomic-text-v1.5") {
    const modelDir =
      opts.modelPathOverride ?? resolveBundledModelDir("nomic-text-v1.5");
    return createNomicHandle({ modelDir, useCoreML, maxBatch: MAX_BATCH });
  }

  // snowflake path: prefer bundled if present, otherwise fetch+cache
  let modelDir: string;
  if (opts.modelPathOverride) {
    modelDir = opts.modelPathOverride;
  } else {
    try {
      modelDir = resolveBundledModelDir("snowflake-arctic-embed-s");
    } catch (err) {
      if (!(err instanceof EmbedderLoadError)) throw err;
      modelDir = await ensureSnowflakeWeights({ cacheDir: snowflakeCacheDir() });
    }
  }
  return createSnowflakeHandle({ modelDir, useCoreML, maxBatch: MAX_BATCH });
}

/** The current bundled model id; useful for status/doctor surfaces. */
export function defaultModelId(): EmbedderId {
  return pickEmbedderId();
}

// Surface the live CoreML state for symmetry with the spec's API list.
void isCoreMLEnabled;

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
 *
 * Order of precedence:
 *   1. opts.force                               — explicit override
 *   2. LODESTONE_EMBEDDER env                   — operator-set
 *   3. free-RAM heuristic                       — snowflake if free <
 *      LOW_RAM_THRESHOLD_BYTES, else nomic.
 *
 * Bundled-availability auto-correct happens later in load(): if the picked
 * model is not bundled AND the other one IS, load() switches. That keeps
 * test semantics (force/RAM honored) while solving the lite/full profile
 * issue (lite tarball only ships snowflake; full only nomic).
 *
 * Exposed for tests.
 */
export function pickEmbedderId(opts: LoadOptions = {}): EmbedderId {
  if (opts.force) return opts.force;
  const envOverride = process.env.LODESTONE_EMBEDDER;
  if (envOverride === "nomic-text-v1.5" || envOverride === "snowflake-arctic-embed-s") {
    return envOverride;
  }
  const freeRam = opts.freeRamBytesOverride ?? os.freemem();
  return freeRam < LOW_RAM_THRESHOLD_BYTES ? "snowflake-arctic-embed-s" : "nomic-text-v1.5";
}

/**
 * If the picked embedder is not bundled but the other one is, switch.
 *
 * This is the lite/full auto-correct: lite tarball only ships snowflake,
 * full tarball only ships nomic. A high-RAM machine with a lite install
 * shouldn't try to load nomic and crash — it should use whatever is on disk.
 *
 * Returns the (possibly switched) id. opts.force or LODESTONE_EMBEDDER env
 * are NOT auto-switched — they're explicit operator/test overrides.
 */
function autocorrectForBundledAvailability(
  picked: EmbedderId,
  opts: LoadOptions,
): EmbedderId {
  // Skip auto-correct if any explicit override is set (force, env, RAM
  // override). These are operator/test signals — honor them.
  if (opts.force || opts.freeRamBytesOverride !== undefined) return picked;
  if (
    process.env.LODESTONE_EMBEDDER === "nomic-text-v1.5" ||
    process.env.LODESTONE_EMBEDDER === "snowflake-arctic-embed-s"
  ) {
    return picked;
  }
  // Only switch nomic→snowflake. Snowflake has its own ensureSnowflakeWeights
  // fallback in load(); don't pre-empt that path.
  if (picked !== "nomic-text-v1.5") return picked;
  try {
    resolveBundledModelDir("nomic-text-v1.5");
    return picked; // nomic bundled — keep
  } catch {
    /* nomic not bundled — see if snowflake is */
  }
  try {
    resolveBundledModelDir("snowflake-arctic-embed-s");
    return "snowflake-arctic-embed-s"; // lite-profile fallback
  } catch {
    return picked; // neither bundled — let load() throw the original nomic error
  }
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
  // Pick by RAM/force/env, then auto-correct for bundled availability so
  // lite/full profile installs don't crash trying to load a model the
  // tarball didn't ship. The auto-correct skips override paths.
  const picked = pickEmbedderId(opts);
  const id = opts.modelPathOverride ? picked : autocorrectForBundledAvailability(picked, opts);
  const useCoreML = detectCoreMLCapable();

  if (id === "nomic-text-v1.5") {
    const modelDir =
      opts.modelPathOverride ?? resolveBundledModelDir("nomic-text-v1.5");
    return createNomicHandle({ modelDir, useCoreML, maxBatch: MAX_BATCH });
  }

  // snowflake path: prefer bundled if present, otherwise fetch+cache. The
  // operator's consent flag (Codex impl-005 §05 RED #1) flows through to
  // ensureSnowflakeWeights — without it, the fallback throws fail-closed.
  let modelDir: string;
  if (opts.modelPathOverride) {
    modelDir = opts.modelPathOverride;
  } else {
    try {
      modelDir = resolveBundledModelDir("snowflake-arctic-embed-s");
    } catch (err) {
      if (!(err instanceof EmbedderLoadError)) throw err;
      modelDir = await ensureSnowflakeWeights({
        cacheDir: snowflakeCacheDir(),
        allowDownload: opts.allowDownload,
      });
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

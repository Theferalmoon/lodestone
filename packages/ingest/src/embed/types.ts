// SPDX-License-Identifier: Apache-2.0
// Public types for the embedder runtime. Kept separate from runtime.ts so
// that bundled-paths / nomic / snowflake / coreml can import them without
// pulling in the dispatcher.

/** The two embedders Lodestone v0 ships. No others. */
export type EmbedderId = "nomic-text-v1.5" | "snowflake-arctic-embed-s";

/**
 * The dispatcher returns a handle that the rest of Lodestone uses to embed
 * batches. `dispose()` is idempotent so callers can defensively call it
 * during cleanup without race-condition fear.
 */
export interface EmbedderHandle {
  readonly id: EmbedderId;
  readonly dim: number;
  readonly maxBatch: number;
  embed(texts: string[]): Promise<Float32Array[]>;
  dispose(): Promise<void>;
}

/** Loader options. */
export interface LoadOptions {
  /** Force a specific embedder; bypasses the RAM auto-fallback. */
  force?: EmbedderId;
  /** Override the RAM check (bytes free). For tests + doctor. */
  freeRamBytesOverride?: number;
  /** Override the resolved model dir (for tests). */
  modelPathOverride?: string;
  /**
   * Per-call operator consent for the snowflake fallback's runtime fetch
   * path. Equivalent to setting `LODESTONE_ALLOW_MODEL_DOWNLOAD=1` in env;
   * either is sufficient. When neither is set, `load()` REFUSES to fetch
   * snowflake weights from the network even if LODESTONE_OFFLINE is unset
   * — silence is not consent. See Codex impl-005 §05 RED #1.
   */
  allowDownload?: boolean;
}

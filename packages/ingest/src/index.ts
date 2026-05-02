// SPDX-License-Identifier: Apache-2.0
// Public surface of @lodestone/ingest. Section 05 ships the embedder runtime;
// later sections (06 parsers, 07 graph builder) add their own subpaths.

export {
  load,
  pickEmbedderId,
  defaultModelId,
  isCoreMLEnabled,
  EmbedderLoadError,
  LOW_RAM_THRESHOLD_BYTES,
  MAX_BATCH,
} from "./embed/runtime.js";
export type {
  EmbedderHandle,
  EmbedderId,
  LoadOptions,
} from "./embed/runtime.js";

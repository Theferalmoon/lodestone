// SPDX-License-Identifier: Apache-2.0
// `ReadyJson` — the readiness marker written by ingest after a successful
// index pass. Producers: §07/§08 (graph build + storage layer), §12 (watcher).
// Consumers: §03 (status command), §13–§17 (MCP server). Codex impl-002 D3:
// without a shared schema each section invents its own incompatible shape.
//
// Field-for-field with claude-plan.md §1.5. The marker is written atomically
// (write to `.tmp`, fsync, rename); MCP tools read it on every request and
// degrade to an empty-results envelope when the file is absent, `ready: false`,
// or `index_epoch` doesn't match the SQLite `schema_version` table.
import { z } from "zod";

export interface ReadyJsonEmbedder {
  /** Embedder model id, e.g. "nomic-embed-text-v1.5". */
  id: string;
  /** Output dimension count. */
  dim: number;
  /** Quantization tag, e.g. "int8" / "fp32". */
  quant: string;
}

export interface ReadyJson {
  /** SQLite schema version at write time. */
  schema_version: number;
  /** Lodestone CLI version at write time, e.g. "0.1.0". */
  lodestone_version: string;
  /** True when the index is consistent enough to serve queries. */
  ready: boolean;
  /** Embedder identity used to populate vector columns. */
  embedder: ReadyJsonEmbedder;
  /** Languages successfully parsed at least once during this index pass. */
  languages_indexed: string[];
  /** ISO-8601 timestamp of the write. */
  indexed_at: string;
  /** Short hash at write time. `null` if not a git repo. */
  commit_at_index: string | null;
  /** True when the working tree was dirty when the index was written. */
  dirty_at_index: boolean;
  /** Monotonic counter; matches Provenance.index_epoch. */
  index_epoch: number;
  /** PID of the writer process — useful for stale-lock detection by MCP. */
  writer_pid: number;
}

const embedderSchema = z
  .object({
    id: z.string().min(1),
    dim: z.number().int().min(1),
    quant: z.string().min(1),
  })
  .strict();

export const readyJsonSchema = z
  .object({
    schema_version: z.number().int().min(1),
    lodestone_version: z.string().min(1),
    ready: z.boolean(),
    embedder: embedderSchema,
    languages_indexed: z.array(z.string()),
    indexed_at: z.string(),
    commit_at_index: z.string().nullable(),
    dirty_at_index: z.boolean(),
    index_epoch: z.number().int().nonnegative(),
    writer_pid: z.number().int().nonnegative(),
  })
  .strict();

/** Validates a candidate ReadyJson. Throws ZodError on invalid shape. */
export function parseReadyJson(raw: unknown): ReadyJson {
  return readyJsonSchema.parse(raw);
}

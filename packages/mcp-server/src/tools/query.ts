// SPDX-License-Identifier: Apache-2.0
// `query` tool — STUB. Real body lands in §14. Schema is the production zod
// shape from claude-plan.md §4 so callers get useful validation errors today.
import { z } from "zod";

import { LODESTONE_CHANNEL_V0, wrapNotImplemented, type LodestoneToolResponseV13 } from "../envelope.js";

export const description =
  "Hybrid semantic + keyword + graph search over the project's symbols. Returns the top-K most relevant functions, methods, classes, interfaces, types, modules, or constants for a natural-language question. Combines vector similarity (sqlite-vec), BM25 keyword match, and PageRank-weighted graph proximity. Supports filters by file path, language, and recency. Use this as the default discovery tool when the agent needs to find code by intent rather than by exact name.";

export const inputSchema = z.object({
  question: z.string().min(1, "question must be non-empty"),
  top_k: z.number().int().min(1).max(50).default(10),
  filters: z
    .object({
      paths: z.array(z.string()).optional(),
      languages: z.array(z.string()).optional(),
      since: z.string().optional(),
    })
    .optional(),
  channel: z.literal("code").optional(),
});

export type QueryInput = z.infer<typeof inputSchema>;

export async function handler(_input: unknown): Promise<LodestoneToolResponseV13<unknown>> {
  return wrapNotImplemented(LODESTONE_CHANNEL_V0);
}

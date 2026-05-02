// SPDX-License-Identifier: Apache-2.0
// `context` tool — STUB. Real body lands in §15.
import { z } from "zod";

import { LODESTONE_CHANNEL_V0, wrapNotImplemented, type LodestoneToolResponseV13 } from "../envelope.js";

export const description =
  "Return the architectural context surrounding a specific symbol: its callers, callees, the cluster it belongs to, the cluster's purpose, sibling symbols inside the same cluster, and any skill cards that mention it. Use this when the agent has a candidate symbol (from `query` or from a stack trace) and needs to understand how it fits into the codebase before editing. Pulls from SQLite edges, clusters, and skills tables in a single bounded read pass.";

export const inputSchema = z.object({
  symbol: z.string().min(1, "symbol must be non-empty"),
  channel: z.literal("code").optional(),
});

export type ContextInput = z.infer<typeof inputSchema>;

export async function handler(_input: unknown): Promise<LodestoneToolResponseV13<unknown>> {
  return wrapNotImplemented(LODESTONE_CHANNEL_V0);
}

// SPDX-License-Identifier: Apache-2.0
// `recent_changes` tool — STUB. Real body lands in §14.
import { z } from "zod";

import { LODESTONE_CHANNEL_V0, wrapNotImplemented, type LodestoneToolResponseV13 } from "../envelope.js";

export const description =
  "List symbols (functions, methods, classes) most recently touched by git commits in the project. Optional ISO-8601 `since` filter narrows to a time window; default top_k=20 returns the freshest changes. Useful when the agent needs to orient on what just changed before answering a question, debugging a regression, or summarizing the day's work. Reads from the SQLite `symbols.updated_at_commit` index — no shell-out to git on the request path.";

export const inputSchema = z.object({
  since: z.string().optional(),
  top_k: z.number().int().min(1).max(50).default(20),
  channel: z.literal("code").optional(),
});

export type RecentChangesInput = z.infer<typeof inputSchema>;

export async function handler(_input: unknown): Promise<LodestoneToolResponseV13<unknown>> {
  return wrapNotImplemented(LODESTONE_CHANNEL_V0);
}

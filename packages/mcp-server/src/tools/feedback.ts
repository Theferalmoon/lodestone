// SPDX-License-Identifier: Apache-2.0
// `feedback` tool — STUB. Real body lands in §17. WRITE tool — appends an
// event to the SQLite `feedback` table referencing a prior tool call by
// request_id. Drives the offline training-pair pipeline.
import { z } from "zod";

import { FEEDBACK_SIGNALS } from "@lodestone/shared";

import { LODESTONE_CHANNEL_V0, wrapNotImplemented, type LodestoneToolResponseV13 } from "../envelope.js";

export const description =
  "Record agent feedback on a prior Lodestone tool call. Required fields: the tool name (`query`, `cluster`, `context`, etc.), the prior call's `request_id` (UUID v7 from the prior envelope), and a `signal` literal (`useful` | `not_useful` | `wrong` | `stale`). Optional `note` (≤2 KB) explains why. Feedback is the training signal Lodestone uses to improve cluster names, skill cards, and ranking — call this whenever a prior tool call was meaningfully helpful or unhelpful.";

export const inputSchema = z.object({
  tool: z.string().min(1, "tool must be non-empty"),
  request_id: z.string().min(1, "request_id is required (UUID from prior call)"),
  signal: z.enum(FEEDBACK_SIGNALS),
  note: z.string().optional(),
  channel: z.literal("code").optional(),
});

export type FeedbackToolInput = z.infer<typeof inputSchema>;

export async function handler(_input: unknown): Promise<LodestoneToolResponseV13<unknown>> {
  return wrapNotImplemented(LODESTONE_CHANNEL_V0);
}

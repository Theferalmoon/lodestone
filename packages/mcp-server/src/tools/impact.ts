// SPDX-License-Identifier: Apache-2.0
// `impact` tool — STUB. Real body lands in §15.
import { z } from "zod";

import { LODESTONE_CHANNEL_V0, wrapNotImplemented, type LodestoneToolResponseV13 } from "../envelope.js";

export const description =
  "Return the reverse-reachability set for a file or symbol: all callers, all transitive importers, the clusters they live in, and a rough blast-radius score. Use this BEFORE editing a function to understand what might break, or AFTER seeing a test fail to find related call sites. Backed by a recursive CTE over the SQLite `edges` table — bounded by depth and result count to keep response size sane.";

export const inputSchema = z.object({
  file_or_symbol: z.string().min(1, "file_or_symbol must be non-empty"),
  channel: z.literal("code").optional(),
});

export type ImpactInput = z.infer<typeof inputSchema>;

export async function handler(_input: unknown): Promise<LodestoneToolResponseV13<unknown>> {
  return wrapNotImplemented(LODESTONE_CHANNEL_V0);
}

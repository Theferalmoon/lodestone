// SPDX-License-Identifier: Apache-2.0
// `cluster` tool — STUB. Real body lands in §16. ★ moat tool: surfaces the
// project's emergent architecture (Louvain communities) as named groups with
// agent-readable instructions for how to interact with each cluster.
import { z } from "zod";

import { LODESTONE_CHANNEL_V0, wrapNotImplemented, type LodestoneToolResponseV13 } from "../envelope.js";

export const description =
  "Return the architectural cluster (community) matching a name or natural-language query. Each cluster is a Louvain-detected group of symbols representing an emergent module — auth, payments, ingest, etc. The response carries the cluster's heuristic name, its name_status (heuristic vs human-confirmed), an agent_instruction string telling the calling agent how to interact with the cluster, naming_evidence (top tokens / files / signature snippets that drove the name), and the member symbol IDs. Granularity selects between Louvain resolution levels (fine | medium | coarse). This is the core moat surface for code-aware agents.";

export const inputSchema = z.object({
  name_or_query: z.string().min(1, "name_or_query must be non-empty"),
  granularity: z.enum(["fine", "medium", "coarse"]).default("medium"),
  channel: z.literal("code").optional(),
});

export type ClusterInput = z.infer<typeof inputSchema>;

export async function handler(_input: unknown): Promise<LodestoneToolResponseV13<unknown>> {
  return wrapNotImplemented(LODESTONE_CHANNEL_V0);
}

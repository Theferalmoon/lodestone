// SPDX-License-Identifier: Apache-2.0
// `sql` tool — STUB. Real body lands in §15. POST-CODEX-001: this is the
// renamed `cypher` tool — same gating semantics. Registered ONLY when
// `[mcp].dangerous_tools_enabled = true` in lodestone.toml. Defense-in-depth:
// even if registered, the underlying SQLite handle is opened readonly so
// write attempts throw at the driver layer.
import { z } from "zod";

import { LODESTONE_CHANNEL_V0, wrapNotImplemented, type LodestoneToolResponseV13 } from "../envelope.js";

export const description =
  "Execute an arbitrary SQL query against the project's read-only Lodestone SQLite index. Returns rows as JSON. DANGEROUS: only registered when `[mcp].dangerous_tools_enabled = true`. The connection is opened readonly at the driver level so write attempts (INSERT, UPDATE, DELETE, DROP) throw — but the operator should still treat exposing this tool as a power-user feature, not a default. Use for ad-hoc graph traversals beyond the canned `query` / `context` / `impact` / `cluster` tools, or for debugging the index itself.";

export const inputSchema = z.object({
  query: z.string().min(1, "query must be non-empty"),
  channel: z.literal("code").optional(),
});

export type SqlInput = z.infer<typeof inputSchema>;

export const dangerous = true;

export async function handler(_input: unknown): Promise<LodestoneToolResponseV13<unknown>> {
  return wrapNotImplemented(LODESTONE_CHANNEL_V0);
}

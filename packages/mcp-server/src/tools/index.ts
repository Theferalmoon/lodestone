// SPDX-License-Identifier: Apache-2.0
// Tool registry — single source of truth for the MCP tool surface. server.ts
// iterates this map, applies the `[mcp].expose` filter from lodestone.toml,
// and registers each remaining entry with the SDK.
//
// Defense-in-depth: `sql` is gated by `dangerous: true`; the registry's
// `buildActiveRegistry()` helper REFUSES to include `sql` unless BOTH the
// expose list contains it AND the config flag is true. The shared config
// schema also enforces this at parse time (see @lodestone/shared
// config/schema.ts mcpSchema.refine), so the runtime check here is purely
// defense-in-depth — neither layer alone is sufficient if the other ever
// drifts.

import type { ZodTypeAny } from "zod";

import type { McpToolName } from "@lodestone/shared";

import type { LodestoneToolResponseV13 } from "../envelope.js";

import * as queryTool from "./query.js";
import * as recentChangesTool from "./recent_changes.js";
import * as contextTool from "./context.js";
import * as impactTool from "./impact.js";
import * as clusterTool from "./cluster.js";
import * as skillsForTool from "./skills_for.js";
import * as feedbackTool from "./feedback.js";
import * as sqlTool from "./sql.js";
import type { JsonSchemaObject } from "./_shared.js";

export interface ToolEntry {
  name: McpToolName;
  description: string;
  /** Runtime validator. Handlers safeParse() this on every call — the trust
   * boundary lives in the handler, not in the wire schema. */
  inputSchema: ZodTypeAny;
  /** Pre-computed JSON-Schema-7 view of `inputSchema`. Surfaced to MCP clients
   * (Claude Code, Cursor, Cline) via `tools/list` so they get schema-level
   * validation UX before dispatch. Pre-computed at module load by each tool —
   * see `toMcpInputSchema` in `_shared.ts`. Closes impl-013 placeholder. */
  jsonSchema: JsonSchemaObject;
  handler: (input: unknown) => Promise<LodestoneToolResponseV13<unknown>>;
  /** True only for `sql`. Server gates registration on the dangerous_tools_enabled flag. */
  dangerous?: boolean;
}

/**
 * The full registry, alphabetically ordered for deterministic listing. Adding
 * a new tool means: drop a `tools/<name>.ts` stub, then add an entry here.
 * server.ts has no per-tool wiring — it is purely data-driven.
 */
export const TOOL_REGISTRY: Readonly<Record<McpToolName, ToolEntry>> = Object.freeze({
  cluster: {
    name: "cluster",
    description: clusterTool.description,
    inputSchema: clusterTool.inputSchema,
    jsonSchema: clusterTool.jsonSchema,
    handler: clusterTool.handler,
  },
  context: {
    name: "context",
    description: contextTool.description,
    inputSchema: contextTool.inputSchema,
    jsonSchema: contextTool.jsonSchema,
    handler: contextTool.handler,
  },
  feedback: {
    name: "feedback",
    description: feedbackTool.description,
    inputSchema: feedbackTool.inputSchema,
    jsonSchema: feedbackTool.jsonSchema,
    handler: feedbackTool.handler,
  },
  impact: {
    name: "impact",
    description: impactTool.description,
    inputSchema: impactTool.inputSchema,
    jsonSchema: impactTool.jsonSchema,
    handler: impactTool.handler,
  },
  query: {
    name: "query",
    description: queryTool.description,
    inputSchema: queryTool.inputSchema,
    jsonSchema: queryTool.jsonSchema,
    handler: queryTool.handler,
  },
  recent_changes: {
    name: "recent_changes",
    description: recentChangesTool.description,
    inputSchema: recentChangesTool.inputSchema,
    jsonSchema: recentChangesTool.jsonSchema,
    handler: recentChangesTool.handler,
  },
  skills_for: {
    name: "skills_for",
    description: skillsForTool.description,
    inputSchema: skillsForTool.inputSchema,
    jsonSchema: skillsForTool.jsonSchema,
    handler: skillsForTool.handler,
  },
  sql: {
    name: "sql",
    description: sqlTool.description,
    inputSchema: sqlTool.inputSchema,
    jsonSchema: sqlTool.jsonSchema,
    handler: sqlTool.handler,
    dangerous: true,
  },
});

/**
 * Stable iteration order — alphabetical by tool name. Matches the freeze order
 * above; explicit so a future refactor can't accidentally shuffle it.
 */
export const TOOL_NAMES_ALPHABETICAL: readonly McpToolName[] = Object.freeze([
  "cluster",
  "context",
  "feedback",
  "impact",
  "query",
  "recent_changes",
  "skills_for",
  "sql",
] as const);

export interface BuildOptions {
  /** From `[mcp].expose` — restricts the active set to these tools only. */
  expose: readonly McpToolName[];
  /** From `[mcp].dangerous_tools_enabled`. Required for `sql` to be admitted. */
  dangerousToolsEnabled: boolean;
}

/**
 * Filter the full registry into the active set for this server instance.
 * Throws when `expose` includes `sql` but `dangerousToolsEnabled` is false —
 * fail loud per §13 spec. The shared config layer also enforces this at TOML
 * parse time; both checks are intentional belt-and-suspenders.
 */
export function buildActiveRegistry(opts: BuildOptions): ToolEntry[] {
  if (opts.expose.includes("sql") && !opts.dangerousToolsEnabled) {
    throw new Error(
      "lodestone.toml exposes `sql` but [mcp].dangerous_tools_enabled is false. " +
        "Either remove `sql` from [mcp].expose, or set dangerous_tools_enabled = true.",
    );
  }
  const active: ToolEntry[] = [];
  // Iterate alphabetically so MCP `tools/list` returns deterministic order.
  for (const name of TOOL_NAMES_ALPHABETICAL) {
    if (!opts.expose.includes(name)) continue;
    const entry: ToolEntry = TOOL_REGISTRY[name];
    if (entry.dangerous && !opts.dangerousToolsEnabled) continue; // belt-and-suspenders
    active.push(entry);
  }
  return active;
}

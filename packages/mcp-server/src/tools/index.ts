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

export interface ToolEntry {
  name: McpToolName;
  description: string;
  inputSchema: ZodTypeAny;
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
    handler: clusterTool.handler,
  },
  context: {
    name: "context",
    description: contextTool.description,
    inputSchema: contextTool.inputSchema,
    handler: contextTool.handler,
  },
  feedback: {
    name: "feedback",
    description: feedbackTool.description,
    inputSchema: feedbackTool.inputSchema,
    handler: feedbackTool.handler,
  },
  impact: {
    name: "impact",
    description: impactTool.description,
    inputSchema: impactTool.inputSchema,
    handler: impactTool.handler,
  },
  query: {
    name: "query",
    description: queryTool.description,
    inputSchema: queryTool.inputSchema,
    handler: queryTool.handler,
  },
  recent_changes: {
    name: "recent_changes",
    description: recentChangesTool.description,
    inputSchema: recentChangesTool.inputSchema,
    handler: recentChangesTool.handler,
  },
  skills_for: {
    name: "skills_for",
    description: skillsForTool.description,
    inputSchema: skillsForTool.inputSchema,
    handler: skillsForTool.handler,
  },
  sql: {
    name: "sql",
    description: sqlTool.description,
    inputSchema: sqlTool.inputSchema,
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

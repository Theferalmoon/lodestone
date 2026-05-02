// SPDX-License-Identifier: Apache-2.0
// v0.1.1 — Tool inputSchema (JSON-Schema-7) tests. Closes impl-013 open
// question: §13 shipped a `{ additionalProperties: true }` placeholder for
// every MCP tool's `tools/list` payload. This suite enforces that every tool
// now exposes a real, closed JSON-Schema-7 view derived from its zod schema —
// MCP clients (Claude Code, Cursor, Cline) get schema-level validation UX,
// not just a permissive "object" stamp.
//
// Properties asserted per tool:
//   1. `type === "object"`
//   2. `additionalProperties === false` (closed shape)
//   3. `properties` is a non-empty record
//   4. `required` lists at least one field for every tool that has a required
//      input (every tool except those with all-optional inputs — assert the
//      field exists when expected).
//   5. The pre-computed value is shared with the registry entry (i.e., the
//      tool module export and TOOL_REGISTRY[name].jsonSchema are the same
//      reference — no per-call recompute on the server hot path).

import { describe, it, expect } from "vitest";

import {
  TOOL_NAMES_ALPHABETICAL,
  TOOL_REGISTRY,
} from "../tools/index.js";
import * as queryTool from "../tools/query.js";
import * as recentChangesTool from "../tools/recent_changes.js";
import * as contextTool from "../tools/context.js";
import * as impactTool from "../tools/impact.js";
import * as clusterTool from "../tools/cluster.js";
import * as skillsForTool from "../tools/skills_for.js";
import * as feedbackTool from "../tools/feedback.js";
import * as sqlTool from "../tools/sql.js";

/** The set of tools that have at least one REQUIRED input field. Tools whose
 * schema is entirely optional (e.g., a hypothetical no-arg tool) would be
 * exempt — none currently exist, so every tool below carries a required key. */
const TOOLS_WITH_REQUIRED_FIELDS: Record<string, string> = {
  query: "question",
  recent_changes: "", // all-optional (since/top_k/channel) — special-cased below
  context: "symbol",
  impact: "file_or_symbol",
  cluster: "name_or_query",
  skills_for: "task_description",
  feedback: "tool",
  sql: "query",
};

describe("tools/list inputSchema — JSON-Schema-7 (impl-013 closure)", () => {
  it("every active tool exposes a `jsonSchema` on its registry entry", () => {
    for (const name of TOOL_NAMES_ALPHABETICAL) {
      const entry = TOOL_REGISTRY[name];
      expect(entry.jsonSchema, `tool '${name}' missing jsonSchema`).toBeDefined();
      expect(entry.jsonSchema.type, `tool '${name}' jsonSchema.type`).toBe("object");
    }
  });

  it("every tool's jsonSchema is a CLOSED object (additionalProperties === false)", () => {
    for (const name of TOOL_NAMES_ALPHABETICAL) {
      const entry = TOOL_REGISTRY[name];
      // The default zod-to-json-schema output for z.object() carries
      // `additionalProperties: false` — i.e., the closed shape we want.
      // If a future schema change drifts to `true` (e.g., via `z.passthrough`),
      // this assertion fails loudly at CI time.
      expect(
        entry.jsonSchema.additionalProperties,
        `tool '${name}' must have additionalProperties: false (closed shape)`,
      ).toBe(false);
    }
  });

  it("every tool's jsonSchema lists at least one property in `properties`", () => {
    for (const name of TOOL_NAMES_ALPHABETICAL) {
      const entry = TOOL_REGISTRY[name];
      const props = entry.jsonSchema.properties as Record<string, unknown> | undefined;
      expect(props, `tool '${name}' must have a properties record`).toBeDefined();
      expect(
        Object.keys(props ?? {}).length,
        `tool '${name}' properties must be non-empty`,
      ).toBeGreaterThan(0);
    }
  });

  it("every tool with a required field surfaces it in `required[]`", () => {
    for (const [name, expectedRequired] of Object.entries(TOOLS_WITH_REQUIRED_FIELDS)) {
      if (expectedRequired === "") continue; // all-optional tools (recent_changes)
      const entry = TOOL_REGISTRY[name as keyof typeof TOOL_REGISTRY];
      const required = entry.jsonSchema.required ?? [];
      expect(
        required,
        `tool '${name}' must list '${expectedRequired}' in required[]`,
      ).toContain(expectedRequired);
    }
  });

  it("recent_changes (all-optional) has no `required` or an empty `required[]`", () => {
    const entry = TOOL_REGISTRY.recent_changes;
    const required = entry.jsonSchema.required ?? [];
    expect(required.length).toBe(0);
  });

  it("registry jsonSchema is the SAME REFERENCE as the per-tool module export (no recompute)", () => {
    // Pre-computed at module load — see tools/_shared.ts toMcpInputSchema.
    // This is a perf assertion masquerading as a correctness assertion: if
    // the registry started recomputing on construction, this would break.
    expect(TOOL_REGISTRY.query.jsonSchema).toBe(queryTool.jsonSchema);
    expect(TOOL_REGISTRY.recent_changes.jsonSchema).toBe(recentChangesTool.jsonSchema);
    expect(TOOL_REGISTRY.context.jsonSchema).toBe(contextTool.jsonSchema);
    expect(TOOL_REGISTRY.impact.jsonSchema).toBe(impactTool.jsonSchema);
    expect(TOOL_REGISTRY.cluster.jsonSchema).toBe(clusterTool.jsonSchema);
    expect(TOOL_REGISTRY.skills_for.jsonSchema).toBe(skillsForTool.jsonSchema);
    expect(TOOL_REGISTRY.feedback.jsonSchema).toBe(feedbackTool.jsonSchema);
    expect(TOOL_REGISTRY.sql.jsonSchema).toBe(sqlTool.jsonSchema);
  });

  it("every tool jsonSchema is JSON-serializable (the SDK ships it over stdio)", () => {
    for (const name of TOOL_NAMES_ALPHABETICAL) {
      const entry = TOOL_REGISTRY[name];
      const round = JSON.parse(JSON.stringify(entry.jsonSchema)) as {
        type: unknown;
        additionalProperties?: unknown;
      };
      expect(round.type).toBe("object");
      expect(round.additionalProperties).toBe(false);
    }
  });
});

describe("tools/list inputSchema — channel discriminant surfaced as a property", () => {
  it("every tool whose zod schema accepts a `channel` literal surfaces it in JSON Schema", () => {
    // The §13 envelope contract: every tool input may carry `channel: "code"`.
    // Confirm the JSON-Schema-7 view actually carries that property so MCP
    // clients can offer it as completion.
    for (const name of TOOL_NAMES_ALPHABETICAL) {
      const entry = TOOL_REGISTRY[name];
      const props = entry.jsonSchema.properties as Record<string, { const?: unknown }> | undefined;
      expect(props?.channel, `tool '${name}' must surface 'channel' in JSON Schema`).toBeDefined();
      // Optional + literal "code" — zod-to-json-schema renders this as a
      // string with `const: "code"`. Tolerate either `const` or `enum`.
      const channelProp = props?.channel ?? {};
      const hasConst = "const" in channelProp && channelProp.const === "code";
      const hasEnum =
        "enum" in channelProp &&
        Array.isArray((channelProp as { enum?: unknown }).enum) &&
        ((channelProp as { enum: unknown[] }).enum ?? []).includes("code");
      expect(hasConst || hasEnum, `tool '${name}' channel must be the literal "code"`).toBe(true);
    }
  });
});

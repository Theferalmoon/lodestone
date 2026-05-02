// SPDX-License-Identifier: Apache-2.0
// Tool registry + buildActiveRegistry tests. Validates the alphabetical
// ordering, sql gating, description-length CI gate, and stub handler shape.
import { describe, it, expect } from "vitest";

import {
  TOOL_REGISTRY,
  TOOL_NAMES_ALPHABETICAL,
  buildActiveRegistry,
} from "../tools/index.js";

describe("TOOL_REGISTRY", () => {
  it("has exactly 8 tools (cluster, context, feedback, impact, query, recent_changes, skills_for, sql)", () => {
    expect(Object.keys(TOOL_REGISTRY).sort()).toEqual([
      "cluster",
      "context",
      "feedback",
      "impact",
      "query",
      "recent_changes",
      "skills_for",
      "sql",
    ]);
  });

  it("alphabetical iteration order is locked", () => {
    expect([...TOOL_NAMES_ALPHABETICAL]).toEqual([
      "cluster",
      "context",
      "feedback",
      "impact",
      "query",
      "recent_changes",
      "skills_for",
      "sql",
    ]);
  });

  it("every tool description is >=150 chars (Claude Code tool-search retrieval gate)", () => {
    for (const name of TOOL_NAMES_ALPHABETICAL) {
      const t = TOOL_REGISTRY[name];
      expect(t.description.length, `tool '${name}' description too short`).toBeGreaterThanOrEqual(
        150,
      );
    }
  });

  it("each entry has { name, description, inputSchema, handler } shape", () => {
    for (const name of TOOL_NAMES_ALPHABETICAL) {
      const t = TOOL_REGISTRY[name];
      expect(t.name).toBe(name);
      expect(typeof t.description).toBe("string");
      expect(typeof t.handler).toBe("function");
      // zod schemas have a `parse` method.
      expect(t.inputSchema).toBeDefined();
      expect(typeof (t.inputSchema as { parse?: unknown }).parse).toBe("function");
    }
  });

  it("only sql is marked dangerous", () => {
    for (const name of TOOL_NAMES_ALPHABETICAL) {
      const dangerous = TOOL_REGISTRY[name].dangerous === true;
      expect(dangerous, `tool '${name}' dangerous flag`).toBe(name === "sql");
    }
  });

  it("every stub handler returns a well-formed not_implemented envelope", async () => {
    for (const name of TOOL_NAMES_ALPHABETICAL) {
      const env = await TOOL_REGISTRY[name].handler({});
      expect(env.results).toEqual([]);
      expect(env.diagnostics.warnings).toContain("not_implemented");
      expect(env.channel).toBe("code");
      expect(typeof env.request_id).toBe("string");
      expect(env.request_id.length).toBeGreaterThan(0);
    }
  });
});

describe("buildActiveRegistry", () => {
  it("returns only tools listed in `expose`", () => {
    const active = buildActiveRegistry({
      expose: ["query", "context"],
      dangerousToolsEnabled: false,
    });
    expect(active.map((t) => t.name).sort()).toEqual(["context", "query"]);
  });

  it("does NOT register sql when dangerous_tools_enabled=false (defense-in-depth)", () => {
    // Note: the schema layer would catch this at parse time; here we simulate
    // a hand-built config slipping through. The runtime check throws.
    expect(() =>
      buildActiveRegistry({
        expose: ["query", "sql"],
        dangerousToolsEnabled: false,
      }),
    ).toThrow(/exposes `sql`.*dangerous_tools_enabled is false/);
  });

  it("registers sql ONLY when both `expose` includes it AND dangerous_tools_enabled=true", () => {
    const active = buildActiveRegistry({
      expose: ["query", "sql"],
      dangerousToolsEnabled: true,
    });
    expect(active.map((t) => t.name).sort()).toEqual(["query", "sql"]);
    const sql = active.find((t) => t.name === "sql");
    expect(sql?.dangerous).toBe(true);
  });

  it("dangerous_tools_enabled=true alone does not register sql if `expose` omits it", () => {
    const active = buildActiveRegistry({
      expose: ["query", "context"],
      dangerousToolsEnabled: true,
    });
    expect(active.find((t) => t.name === "sql")).toBeUndefined();
  });

  it("returns active tools in alphabetical order", () => {
    const active = buildActiveRegistry({
      expose: ["skills_for", "cluster", "query"],
      dangerousToolsEnabled: false,
    });
    expect(active.map((t) => t.name)).toEqual(["cluster", "query", "skills_for"]);
  });

  it("default expose set (claude-plan §5) builds without error and excludes sql", () => {
    const active = buildActiveRegistry({
      expose: ["query", "context", "impact", "cluster", "skills_for", "recent_changes", "feedback"],
      dangerousToolsEnabled: false,
    });
    expect(active.map((t) => t.name).sort()).toEqual([
      "cluster",
      "context",
      "feedback",
      "impact",
      "query",
      "recent_changes",
      "skills_for",
    ]);
  });
});

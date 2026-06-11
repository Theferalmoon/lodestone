// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { lodestoneConfigSchema, parseLodestoneConfig } from "./schema.js";

describe("lodestoneConfigSchema (mirror of claude-plan.md §5)", () => {
  it("accepts a minimal config (only [project].name) and applies defaults everywhere else", () => {
    const config = parseLodestoneConfig({ project: { name: "demo" } });

    expect(config.project.name).toBe("demo");
    expect(config.ingest.mode).toBe("watch");
    expect(config.ingest.debounce_ms).toBe(600);
    expect(config.ingest.inherit_gitignore).toBe(true);

    expect(config.embedder.profile).toBe("default");
    expect(config.embedder.batch_size).toBe(16);

    expect(config.cluster.algorithm).toBe("louvain");
    expect(config.cluster.schedule).toBe("nightly");
    expect(config.cluster.resolution).toBe(1.5);

    expect(config.skill_emitter.min_size).toBe(3);
    expect(config.skill_emitter.max_size).toBe(50);
    expect(config.skill_emitter.expire_days).toBe(60);

    expect(config.mcp.dangerous_tools_enabled).toBe(false);
    expect(config.mcp.max_in_flight).toBe(4);
    expect(config.mcp.max_response_kb).toBe(256);

    expect(config.pro.enabled).toBe(false);
    expect(config.pro.temporal_kg_enabled).toBe(false);
  });

  it("`cypher` (and its post-Codex rename `sql`) are NOT in the default expose list", () => {
    const config = parseLodestoneConfig({ project: { name: "demo" } });
    expect(config.mcp.expose).not.toContain("cypher");
    expect(config.mcp.expose).not.toContain("sql");
    // Default exposed tools (per plan §5):
    expect(config.mcp.expose).toEqual([
      "query",
      "context",
      "impact",
      "cluster",
      "skills_for",
      "recent_changes",
      "feedback",
    ]);
  });

  it("rejects malformed configs with field-path information (zod error)", () => {
    expect(() =>
      parseLodestoneConfig({
        project: { name: "demo" },
        cluster: { algorithm: "infomap" },
      })
    ).toThrow(/algorithm/);

    expect(() =>
      parseLodestoneConfig({
        project: { name: "demo" },
        ingest: { debounce_ms: -1 },
      })
    ).toThrow(/debounce_ms/);

    expect(() =>
      parseLodestoneConfig({
        project: { name: "demo" },
        skill_emitter: { min_size: 10, max_size: 5 },
      })
    ).toThrow(/max_size/);

    // Cross-field refine: expire_days must be >= min_age_days
    expect(() =>
      parseLodestoneConfig({
        project: { name: "demo" },
        skill_emitter: { min_age_days: 30, expire_days: 10 },
      })
    ).toThrow(/expire_days/);

    expect(() =>
      parseLodestoneConfig({
        project: { name: "demo" },
        cluster: { schedule: "every-tuesday" },
      })
    ).toThrow(/schedule/);
  });

  it("rejects unknown top-level keys (`.strict()`)", () => {
    expect(() =>
      parseLodestoneConfig({
        project: { name: "demo" },
        wat: { yes: true },
      })
    ).toThrow();
  });

  it("requires [project].name", () => {
    expect(() => parseLodestoneConfig({ project: {} })).toThrow();
    expect(() => parseLodestoneConfig({})).toThrow();
  });

  it("schedule accepts the on_change_threshold:N form", () => {
    const config = parseLodestoneConfig({
      project: { name: "demo" },
      cluster: { schedule: "on_change_threshold:50" },
    });
    expect(config.cluster.schedule).toBe("on_change_threshold:50");
  });

  it("schema export is the same object the parser uses", () => {
    expect(lodestoneConfigSchema).toBeDefined();
  });

  // Codex impl-002 C5/A6: tool-name enum + sql exposure refine.
  it("rejects unknown MCP tool names in expose (typo guard)", () => {
    expect(() =>
      parseLodestoneConfig({
        project: { name: "demo" },
        mcp: { expose: ["qurey"] },
      })
    ).toThrow();
  });

  it("rejects 'sql' in expose unless dangerous_tools_enabled is true", () => {
    expect(() =>
      parseLodestoneConfig({
        project: { name: "demo" },
        mcp: { expose: ["query", "sql"], dangerous_tools_enabled: false },
      })
    ).toThrow(/sql/);
  });

  it("accepts 'sql' in expose when dangerous_tools_enabled is true", () => {
    const config = parseLodestoneConfig({
      project: { name: "demo" },
      mcp: { expose: ["query", "sql"], dangerous_tools_enabled: true },
    });
    expect(config.mcp.expose).toContain("sql");
    expect(config.mcp.dangerous_tools_enabled).toBe(true);
  });

  it("rejects enabling the reserved Pro temporal KG flag in v0 friend mode", () => {
    expect(() =>
      parseLodestoneConfig({
        project: { name: "demo" },
        pro: { temporal_kg_enabled: true },
      })
    ).toThrow(/temporal_kg_enabled/);
  });
});

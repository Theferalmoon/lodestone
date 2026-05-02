// SPDX-License-Identifier: Apache-2.0
// createServer() tests — config-driven registration loop, gating, in-flight
// + truncation wiring. The stdio transport itself is exercised by §20 e2e.
import { describe, it, expect } from "vitest";

import { lodestoneConfigSchema, type LodestoneConfig } from "@lodestone/shared";

import { createServer } from "../server.js";
import { assertLocalStdioTrust } from "../auth.js";

function configWith(overrides: { expose?: string[]; dangerous?: boolean; maxInFlight?: number; maxKb?: number } = {}): LodestoneConfig {
  return lodestoneConfigSchema.parse({
    project: { name: "test", languages: ["typescript"] },
    mcp: {
      expose: overrides.expose ?? [
        "query",
        "context",
        "impact",
        "cluster",
        "skills_for",
        "recent_changes",
        "feedback",
      ],
      dangerous_tools_enabled: overrides.dangerous ?? false,
      max_in_flight: overrides.maxInFlight ?? 4,
      max_response_kb: overrides.maxKb ?? 256,
    },
  });
}

describe("createServer", () => {
  it("registers exactly the tools in [mcp].expose (config-driven)", () => {
    const cfg = configWith({ expose: ["query", "context"] });
    const { activeTools } = createServer({ config: cfg });
    expect(activeTools.map((t) => t.name).sort()).toEqual(["context", "query"]);
  });

  it("does NOT register sql when dangerous_tools_enabled=false (default)", () => {
    const cfg = configWith();
    const { activeTools } = createServer({ config: cfg });
    expect(activeTools.find((t) => t.name === "sql")).toBeUndefined();
  });

  it("registers sql when both expose includes it AND dangerous_tools_enabled=true", () => {
    const cfg = configWith({
      expose: ["query", "sql"],
      dangerous: true,
    });
    const { activeTools } = createServer({ config: cfg });
    expect(activeTools.map((t) => t.name).sort()).toEqual(["query", "sql"]);
  });

  it("constructs an InflightCap sized to [mcp].max_in_flight", () => {
    const cfg = configWith({ maxInFlight: 7 });
    const { inflight } = createServer({ config: cfg });
    expect(inflight.max).toBe(7);
  });

  it("returns a SDK Server instance with a name + version", () => {
    const cfg = configWith();
    const { server } = createServer({ config: cfg, serverName: "lodestone-test", serverVersion: "9.9.9" });
    expect(server).toBeDefined();
  });

  it("active tool descriptions are all >=150 chars (description-length CI gate)", () => {
    const cfg = configWith();
    const { activeTools } = createServer({ config: cfg });
    for (const t of activeTools) {
      expect(t.description.length).toBeGreaterThanOrEqual(150);
    }
  });

  it("YELLOW fix: when dangerous_tools_enabled=true, server sets LODESTONE_DANGEROUS_TOOLS=1 so the sql handler env gate is satisfied", () => {
    const prior = process.env.LODESTONE_DANGEROUS_TOOLS;
    delete process.env.LODESTONE_DANGEROUS_TOOLS;
    try {
      const cfg = configWith({
        expose: ["query", "sql"],
        dangerous: true,
      });
      createServer({ config: cfg });
      expect(process.env.LODESTONE_DANGEROUS_TOOLS).toBe("1");
    } finally {
      if (prior === undefined) delete process.env.LODESTONE_DANGEROUS_TOOLS;
      else process.env.LODESTONE_DANGEROUS_TOOLS = prior;
    }
  });

  it("YELLOW fix: when dangerous_tools_enabled=false, server clears LODESTONE_DANGEROUS_TOOLS (fail-closed)", () => {
    const prior = process.env.LODESTONE_DANGEROUS_TOOLS;
    process.env.LODESTONE_DANGEROUS_TOOLS = "1"; // simulate stale env from a prior run
    try {
      const cfg = configWith({ dangerous: false });
      createServer({ config: cfg });
      expect(process.env.LODESTONE_DANGEROUS_TOOLS).toBeUndefined();
    } finally {
      if (prior === undefined) delete process.env.LODESTONE_DANGEROUS_TOOLS;
      else process.env.LODESTONE_DANGEROUS_TOOLS = prior;
    }
  });

  it("schema-level guard: lodestone.toml that exposes sql without dangerous_tools_enabled is REJECTED at parse time", () => {
    // The shared schema's mcpSchema.refine catches this BEFORE createServer
    // is even called. Confirms layer 1 of the defense-in-depth.
    expect(() =>
      lodestoneConfigSchema.parse({
        project: { name: "x" },
        mcp: { expose: ["query", "sql"], dangerous_tools_enabled: false },
      }),
    ).toThrow();
  });
});

describe("assertLocalStdioTrust (boundary doc)", () => {
  it("returns true (no-op enforcement)", () => {
    expect(assertLocalStdioTrust()).toBe(true);
  });
});

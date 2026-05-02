// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeMcpJson } from "./mcp-config.js";

interface McpJsonShape {
  mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
}

describe("writeMcpJson", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "lodestone-mcp-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("creates .mcp.json at the repo root with the lodestone-mcp entry when absent", () => {
    expect(existsSync(path.join(tmp, ".mcp.json"))).toBe(false);
    const result = writeMcpJson(tmp);
    expect(result.action).toBe("created");
    expect(result.path).toBe(path.join(tmp, ".mcp.json"));
    const cfg = JSON.parse(readFileSync(path.join(tmp, ".mcp.json"), "utf8")) as McpJsonShape;
    expect(cfg.mcpServers["lodestone-mcp"]).toBeDefined();
    expect(typeof cfg.mcpServers["lodestone-mcp"].command).toBe("string");
    expect(Array.isArray(cfg.mcpServers["lodestone-mcp"].args)).toBe(true);
    expect(typeof cfg.mcpServers["lodestone-mcp"].env).toBe("object");
  });

  it("merges into an existing .mcp.json without removing other servers", () => {
    const existing: McpJsonShape = {
      mcpServers: {
        "github-mcp": { command: "/usr/bin/gh-mcp", args: [], env: {} },
        "filesystem-mcp": { command: "/usr/bin/fs-mcp", args: ["--ro"], env: {} },
      },
    };
    writeFileSync(path.join(tmp, ".mcp.json"), JSON.stringify(existing, null, 2));
    const result = writeMcpJson(tmp);
    expect(result.action).toBe("merged");
    const cfg = JSON.parse(readFileSync(path.join(tmp, ".mcp.json"), "utf8")) as McpJsonShape;
    expect(cfg.mcpServers["github-mcp"]).toEqual(existing.mcpServers["github-mcp"]);
    expect(cfg.mcpServers["filesystem-mcp"]).toEqual(existing.mcpServers["filesystem-mcp"]);
    expect(cfg.mcpServers["lodestone-mcp"]).toBeDefined();
  });

  it("idempotent — second call produces a byte-identical file", () => {
    writeMcpJson(tmp);
    const after1 = readFileSync(path.join(tmp, ".mcp.json"));
    writeMcpJson(tmp);
    const after2 = readFileSync(path.join(tmp, ".mcp.json"));
    expect(Buffer.compare(after1, after2)).toBe(0);
  });

  it("the lodestone-mcp `command` is an absolute path under <repoRoot>/.lodestone/runtime/", () => {
    writeMcpJson(tmp);
    const cfg = JSON.parse(readFileSync(path.join(tmp, ".mcp.json"), "utf8")) as McpJsonShape;
    const cmd = cfg.mcpServers["lodestone-mcp"].command;
    expect(path.isAbsolute(cmd)).toBe(true);
    const expectedPrefix = path.join(tmp, ".lodestone", "runtime");
    expect(cmd.startsWith(expectedPrefix)).toBe(true);
  });

  it("overwrites a stale lodestone-mcp entry (e.g., absolute path from another machine)", () => {
    const stale: McpJsonShape = {
      mcpServers: {
        "lodestone-mcp": {
          command: "/home/someone-else/.lodestone/runtime/lodestone-mcp",
          args: ["--stale"],
          env: { LEGACY: "1" },
        },
        "other-mcp": { command: "/usr/bin/other", args: [], env: {} },
      },
    };
    writeFileSync(path.join(tmp, ".mcp.json"), JSON.stringify(stale, null, 2));
    const result = writeMcpJson(tmp);
    expect(result.action).toBe("updated");
    const cfg = JSON.parse(readFileSync(path.join(tmp, ".mcp.json"), "utf8")) as McpJsonShape;
    const cmd = cfg.mcpServers["lodestone-mcp"].command;
    expect(cmd.startsWith(tmp)).toBe(true);
    expect(cmd.includes("someone-else")).toBe(false);
    // Args/env reset to canonical lodestone defaults — stale "--stale" gone
    expect(cfg.mcpServers["lodestone-mcp"].args).toEqual([]);
    expect(cfg.mcpServers["lodestone-mcp"].env).toEqual({});
    // Other servers preserved
    expect(cfg.mcpServers["other-mcp"]).toEqual(stale.mcpServers["other-mcp"]);
  });

  it("preserves user formatting choices when merging (parses JSON, so formatting is normalized to 2-space)", () => {
    // Document the explicit policy: the writer normalizes to 2-space indent + trailing newline.
    // Caller is told this in the docstring; test pins the policy.
    writeFileSync(
      path.join(tmp, ".mcp.json"),
      '{\n\t"mcpServers": {\n\t\t"github-mcp": {"command": "/usr/bin/gh", "args": [], "env": {}}\n\t}\n}\n'
    );
    writeMcpJson(tmp);
    const body = readFileSync(path.join(tmp, ".mcp.json"), "utf8");
    expect(body.endsWith("\n")).toBe(true);
    // No tabs in the output (we use spaces).
    expect(body.includes("\t")).toBe(false);
  });

  it("throws on malformed existing .mcp.json (does not silently overwrite friend's broken file)", () => {
    writeFileSync(path.join(tmp, ".mcp.json"), "{ this is not json");
    expect(() => writeMcpJson(tmp)).toThrow();
  });

  it("rejects mcpServers as an array (Codex §04 RED #1: silent-success bug)", () => {
    // `{ "mcpServers": [] }` is an object per `typeof`, but assigning a
    // string property to an array is a JSON.stringify no-op. The pre-fix
    // code returned `merged` and wrote a file that did NOT contain a
    // lodestone-mcp entry. That violates the install contract.
    writeFileSync(path.join(tmp, ".mcp.json"), JSON.stringify({ mcpServers: [] }));
    expect(() => writeMcpJson(tmp)).toThrow(/mcpServers.*object/i);
  });
});

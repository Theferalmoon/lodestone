// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildClaudeCodeSmokeReport,
  buildCodexSmokeReport,
  buildMcpSmokeReport,
  clientSmoke,
  parseClientSmokeArgv,
} from "../commands/client-smoke.js";
import { writeCodexConfig } from "../install/codex-config.js";
import { writeMcpJson } from "../install/mcp-config.js";
import { installRuntime } from "../install/runtime.js";

describe("parseClientSmokeArgv", () => {
  it("defaults to the Codex smoke target", () => {
    expect(parseClientSmokeArgv([])).toMatchObject({
      client: "codex",
      help: false,
      json: false,
    });
  });

  it("rejects unsupported clients", () => {
    expect(parseClientSmokeArgv(["--client", "cursor"]).clientError).toMatch(
      /Unknown client smoke target/
    );
  });

  it("accepts the Claude Code smoke target", () => {
    expect(parseClientSmokeArgv(["--client", "claude-code"])).toMatchObject({
      client: "claude-code",
      help: false,
      json: false,
    });
  });

  it("accepts the generic MCP smoke target", () => {
    expect(parseClientSmokeArgv(["--client=mcp"])).toMatchObject({
      client: "mcp",
      help: false,
      json: false,
    });
  });
});

describe("client-smoke command", () => {
  let tmp: string;
  let prevCwd: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "lodestone-client-smoke-"));
    prevCwd = process.cwd();
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns 1 when the Codex project config is missing", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await clientSmoke(["--client", "codex"])).toBe(1);
      expect(log.mock.calls.flat().join("\n")).toContain("missing-file");
      expect(err.mock.calls.flat().join("\n")).toContain("Codex smoke prerequisites are not healthy");
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  });

  it("emits Codex inline -c smoke commands when config is healthy", async () => {
    installRuntime(tmp);
    writeCodexConfig(tmp);
    const repoRoot = process.cwd();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await clientSmoke(["--client", "codex"])).toBe(0);
      const stdout = log.mock.calls.flat().join("\n");
      expect(stdout).toContain("runtime command  ok");
      expect(stdout).toContain("codex mcp list");
      expect(stdout).toContain("codex exec");
      expect(stdout).toContain("--ignore-user-config");
      expect(stdout).toContain("--dangerously-bypass-approvals-and-sandbox");
      expect(stdout).toContain(
        `-c 'mcp_servers.lodestone-mcp.command="${repoRoot}/.lodestone/runtime/lodestone-mcp"'`
      );
      expect(err.mock.calls.flat().join("\n")).toContain("Current Codex CLI may not load");
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  });

  it("returns 1 when Codex config is healthy but the runtime shim is missing", async () => {
    writeCodexConfig(tmp);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await clientSmoke(["--client", "codex"])).toBe(1);
      const stdout = log.mock.calls.flat().join("\n");
      expect(stdout).toContain("codex config     ok");
      expect(stdout).toContain("runtime command  missing-or-not-executable");
      expect(err.mock.calls.flat().join("\n")).toContain("Codex smoke prerequisites are not healthy");
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  });

  it("emits one parseable JSON report", async () => {
    installRuntime(tmp);
    writeCodexConfig(tmp);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(await clientSmoke(["--json"])).toBe(0);
      expect(log.mock.calls.length).toBe(1);
      const parsed = JSON.parse(log.mock.calls[0]?.[0] as string);
      expect(parsed.client).toBe("codex");
      expect(parsed.ready_to_smoke).toBe(true);
      expect(parsed.runtime_command_executable).toBe(true);
      expect(parsed.codex_exec_command).toContain("server");
    } finally {
      log.mockRestore();
    }
  });

  it("emits Claude Code --mcp-config smoke commands when .mcp.json is healthy", async () => {
    installRuntime(tmp);
    writeMcpJson(tmp);
    const repoRoot = process.cwd();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await clientSmoke(["--client", "claude-code"])).toBe(0);
      const stdout = log.mock.calls.flat().join("\n");
      expect(stdout).toContain("runtime command  ok");
      expect(stdout).toContain("claude --mcp-config");
      expect(stdout).toContain("--strict-mcp-config");
      expect(stdout).toContain("--permission-mode dontAsk");
      expect(stdout).toContain("--allowedTools mcp__lodestone-mcp__query");
      expect(stdout).toContain(`${repoRoot}/.mcp.json`);
      expect(err.mock.calls.flat().join("\n")).toContain(
        "Claude Code may require project MCP approval"
      );
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  });

  it("returns 1 when Claude Code .mcp.json is healthy but the runtime shim is missing", async () => {
    writeMcpJson(tmp);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await clientSmoke(["--client", "claude-code"])).toBe(1);
      const stdout = log.mock.calls.flat().join("\n");
      expect(stdout).toContain("mcp json         ok");
      expect(stdout).toContain("runtime command  missing-or-not-executable");
      expect(err.mock.calls.flat().join("\n")).toContain(
        "Claude Code smoke prerequisites are not healthy"
      );
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  });

  it("emits one parseable Claude Code JSON report", async () => {
    installRuntime(tmp);
    writeMcpJson(tmp);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(await clientSmoke(["--client", "claude-code", "--json"])).toBe(0);
      expect(log.mock.calls.length).toBe(1);
      const parsed = JSON.parse(log.mock.calls[0]?.[0] as string);
      expect(parsed.client).toBe("claude-code");
      expect(parsed.ready_to_smoke).toBe(true);
      expect(parsed.runtime_command_executable).toBe(true);
      expect(parsed.claude_print_command).toContain("mcp__lodestone-mcp__query");
    } finally {
      log.mockRestore();
    }
  });

  it("returns 1 when generic MCP config is missing", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await clientSmoke(["--client", "mcp"])).toBe(1);
      expect(log.mock.calls.flat().join("\n")).toContain("missing-file");
      expect(err.mock.calls.flat().join("\n")).toContain("Generic MCP smoke prerequisites are not healthy");
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  });

  it("buildMcpSmokeReport reports a successful stdio tool list", async () => {
    installRuntime(tmp);
    writeMcpJson(tmp);
    const report = await buildMcpSmokeReport(tmp, async () => ({
      ok: true,
      protocolVersion: "2024-11-05",
      serverName: "lodestone",
      serverVersion: "0.1.14",
      toolNames: ["query", "context", "impact"],
    }));

    expect(report).toMatchObject({
      client: "mcp",
      config_state: "ok",
      runtime_command_executable: true,
      handshake_attempted: true,
      handshake_ok: true,
      protocol_version: "2024-11-05",
      server_name: "lodestone",
      server_version: "0.1.14",
      ready_to_smoke: true,
      tool_count: 3,
      tool_names: ["query", "context", "impact"],
    });
  });

  it("clientSmoke --client mcp performs a real stdio JSON-RPC handshake", async () => {
    const runtimePath = path.join(tmp, ".lodestone", "runtime", "lodestone-mcp");
    const fakeServerPath = path.join(tmp, ".lodestone", "runtime", "fake-server.cjs");
    mkdirSync(path.dirname(runtimePath), { recursive: true });
    writeMcpJson(tmp);
    writeFileSync(
      runtimePath,
      [
        "#!/bin/sh",
        'exec node "$(dirname "$0")/fake-server.cjs" "$@"',
      ].join("\n")
    );
    writeFileSync(
      fakeServerPath,
      [
        "const readline = require('node:readline');",
        "const rl = readline.createInterface({ input: process.stdin });",
        "rl.on('line', (line) => {",
        "  const msg = JSON.parse(line);",
        "  if (msg.method === 'initialize') {",
        "    console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, method: 'sampling/createMessage', params: {} }));",
        "    console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake-lodestone', version: '9.9.9' } } }));",
        "  }",
        "  if (msg.method === 'tools/list') {",
        "    console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, method: 'roots/list', params: {} }));",
        "    console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'query' }, { name: 'context' }] } }));",
        "  }",
        "});",
      ].join("\n")
    );
    chmodSync(runtimePath, 0o755);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(await clientSmoke(["--client", "mcp", "--json"])).toBe(0);
      const parsed = JSON.parse(log.mock.calls[0]?.[0] as string);
      expect(parsed.client).toBe("mcp");
      expect(parsed.handshake_ok).toBe(true);
      expect(parsed.protocol_version).toBe("2024-11-05");
      expect(parsed.server_name).toBe("fake-lodestone");
      expect(parsed.server_version).toBe("9.9.9");
      expect(parsed.tool_names).toEqual(["context", "query"]);
    } finally {
      log.mockRestore();
    }
  });

  it("buildMcpSmokeReport launches the exact .mcp.json args/env", async () => {
    const runtime = installRuntime(tmp);
    writeFileSync(
      path.join(tmp, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "lodestone-mcp": {
            command: runtime.path,
            args: ["--fixture"],
            env: { LODESTONE_LOG_LEVEL: "debug" },
          },
        },
      })
    );
    const seen: Array<{ commandArgs: string[]; commandEnv: Record<string, string> }> = [];
    const report = await buildMcpSmokeReport(tmp, async (args) => {
      seen.push({ commandArgs: args.commandArgs, commandEnv: args.commandEnv });
      return {
        ok: true,
        toolNames: ["query"],
      };
    });

    expect(report.ready_to_smoke).toBe(true);
    expect(seen).toEqual([
      {
        commandArgs: ["--fixture"],
        commandEnv: { LODESTONE_LOG_LEVEL: "debug" },
      },
    ]);
  });

  it("buildMcpSmokeReport preserves handshake failures", async () => {
    installRuntime(tmp);
    writeMcpJson(tmp);
    const report = await buildMcpSmokeReport(tmp, async () => ({
      ok: false,
      error: "MCP tools/list failed",
    }));

    expect(report).toMatchObject({
      client: "mcp",
      config_state: "ok",
      runtime_command_executable: true,
      handshake_attempted: true,
      handshake_ok: false,
      ready_to_smoke: false,
      tool_count: 0,
      tool_names: [],
      handshake_error: "MCP tools/list failed",
    });
  });

  it("buildCodexSmokeReport keeps apostrophes shell-safe", () => {
    const repo = path.join(tmpdir(), "lodestone friend's repo");
    const report = buildCodexSmokeReport(repo, "find Bob's symbol");
    expect(report.codex_exec_command).toContain("friend'\\''s repo");
    expect(report.codex_exec_command).toContain("Bob'\\''s symbol");
  });

  it("buildCodexSmokeReport emits custom prompts after an argument delimiter", () => {
    const report = buildCodexSmokeReport(tmp, "--find the auth symbol");
    expect(report.codex_exec_command).toContain("-- '--find the auth symbol'");
  });

  it("buildClaudeCodeSmokeReport keeps apostrophes shell-safe", () => {
    const repo = path.join(tmpdir(), "lodestone friend's repo");
    const report = buildClaudeCodeSmokeReport(repo, "find Bob's symbol");
    expect(report.claude_print_command).toContain("friend'\\''s repo");
    expect(report.claude_print_command).toContain("Bob'\\''s symbol");
  });

  it("buildClaudeCodeSmokeReport emits custom prompts after an argument delimiter", () => {
    const report = buildClaudeCodeSmokeReport(tmp, "--find the auth symbol");
    expect(report.claude_print_command).toContain("-- '--find the auth symbol'");
  });
});

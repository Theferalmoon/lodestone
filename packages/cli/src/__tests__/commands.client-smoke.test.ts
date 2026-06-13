// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildClaudeCodeSmokeReport,
  buildCodexSmokeReport,
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

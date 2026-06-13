// SPDX-License-Identifier: Apache-2.0
// Client compatibility smoke helpers. The command is intentionally no-mutation
// by default: it validates generated project config and prints exact commands
// a maintainer can run in a trusted/disposable repo.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { canonicalCodexMcpEntry, checkCodexConfig } from "../install/codex-config.js";
import { checkMcpJson, MCP_SERVER_NAME } from "../install/mcp-config.js";
import { output } from "../ui/output.js";

export interface ClientSmokeOptions {
  client: "codex" | "claude-code" | "mcp";
  help: boolean;
  json: boolean;
  prompt: string;
  clientError?: string;
}

interface CodexSmokeReport {
  client: "codex";
  repo_root: string;
  config_state: ReturnType<typeof checkCodexConfig>["state"];
  config_path: string;
  runtime_command_path: string;
  runtime_command_executable: boolean;
  ready_to_smoke: boolean;
  caveat: string;
  codex_mcp_list_command: string;
  codex_exec_command: string;
}

interface ClaudeCodeSmokeReport {
  client: "claude-code";
  repo_root: string;
  config_state: ReturnType<typeof checkMcpJson>["state"];
  config_path: string;
  runtime_command_path: string;
  runtime_command_executable: boolean;
  ready_to_smoke: boolean;
  caveat: string;
  claude_mcp_list_command: string;
  claude_print_command: string;
}

interface McpSmokeReport {
  client: "mcp";
  repo_root: string;
  config_state: ReturnType<typeof checkMcpJson>["state"];
  config_path: string;
  runtime_command_path: string;
  runtime_command_executable: boolean;
  handshake_attempted: boolean;
  handshake_ok: boolean;
  protocol_version?: string;
  server_name?: string;
  server_version?: string;
  tool_count: number;
  tool_names: string[];
  handshake_error?: string;
  ready_to_smoke: boolean;
  caveat: string;
}

type ClientSmokeReport = CodexSmokeReport | ClaudeCodeSmokeReport | McpSmokeReport;

interface McpHandshakeSuccess {
  ok: true;
  protocolVersion?: string;
  serverName?: string;
  serverVersion?: string;
  toolNames: string[];
}

interface McpHandshakeFailure {
  ok: false;
  error: string;
}

export type McpHandshakeResult = McpHandshakeSuccess | McpHandshakeFailure;
export type McpHandshakeRunner = (args: {
  repoRoot: string;
  commandPath: string;
  commandArgs: string[];
  commandEnv: Record<string, string>;
  timeoutMs: number;
}) => Promise<McpHandshakeResult>;

interface McpLaunchConfig {
  commandPath: string;
  commandArgs: string[];
  commandEnv: Record<string, string>;
}

const DEFAULT_CODEX_PROMPT =
  "Use the Lodestone MCP query tool from this project to find a known symbol. " +
  "Do not use shell commands, direct file reads, or SQLite. Reply compact JSON " +
  "with used_lodestone_tool, symbol_name, and path.";

const DEFAULT_CLAUDE_CODE_PROMPT =
  "Use the Lodestone MCP query tool to find a known symbol in this project. " +
  "Do not use Bash, file reads, or shell commands. Reply compact JSON with " +
  "used_lodestone_tool, symbol_name, and path.";

export function parseClientSmokeArgv(argv: readonly string[]): ClientSmokeOptions {
  const opts: ClientSmokeOptions = {
    client: "codex",
    help: false,
    json: false,
    prompt: DEFAULT_CODEX_PROMPT,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg === "--json") {
      opts.json = true;
    } else if (arg === "--client") {
      const value = argv[++i];
      if (value === undefined || value === "") {
        opts.clientError = "--client requires a value";
        continue;
      }
      parseClientValue(value, opts);
    } else if (arg?.startsWith("--client=")) {
      parseClientValue(arg.slice("--client=".length), opts);
    } else if (arg === "--prompt") {
      const value = argv[++i];
      if (value === undefined || value === "") {
        opts.clientError = "--prompt requires a value";
        continue;
      }
      opts.prompt = value;
    } else if (arg?.startsWith("--prompt=")) {
      opts.prompt = arg.slice("--prompt=".length);
    } else {
      opts.clientError = `Unknown option: ${arg}`;
    }
  }

  return opts;
}

export function printClientSmokeHelp(): void {
  console.log(
    [
      "lodestone client-smoke - emit real-client compatibility smoke commands.",
      "",
      "USAGE",
      "  lodestone client-smoke --client codex",
      "  lodestone client-smoke --client claude-code",
      "  lodestone client-smoke --client mcp",
      "  lodestone client-smoke --client codex --json",
      "",
      "OPTIONS",
      "  --client codex         Validate the Codex adapter and emit inline MCP smoke commands.",
      "  --client claude-code   Validate .mcp.json and emit Claude Code smoke commands.",
      "  --client mcp           Launch the repo-local MCP server and list tools over stdio.",
      "  --prompt <text>        Prompt to embed in emitted Codex/Claude Code commands.",
      "  --json              Emit one machine-readable report.",
      "  -h, --help          Show this help message.",
      "",
      "NOTES",
      "  The command does not edit global client config.",
      "  Emitted commands are intended for trusted disposable smoke repos.",
    ].join("\n")
  );
}

export async function clientSmoke(argv: readonly string[]): Promise<number> {
  const opts = parseClientSmokeArgv(argv);
  if (opts.help) {
    printClientSmokeHelp();
    return 0;
  }
  if (opts.clientError !== undefined) {
    output.error(opts.clientError);
    output.error("Run `lodestone client-smoke --help` for usage.");
    return 2;
  }

  const repoRoot = process.cwd();
  const report: ClientSmokeReport =
    opts.client === "codex"
      ? buildCodexSmokeReport(repoRoot, opts.prompt)
      : opts.client === "claude-code"
        ? buildClaudeCodeSmokeReport(repoRoot, opts.prompt)
        : await buildMcpSmokeReport(repoRoot);
  if (opts.json) {
    output.json(report);
  } else if (report.client === "codex") {
    printCodexSmokeReport(report);
  } else if (report.client === "claude-code") {
    printClaudeCodeSmokeReport(report);
  } else {
    printMcpSmokeReport(report);
  }
  return report.ready_to_smoke ? 0 : 1;
}

export function buildCodexSmokeReport(repoRoot: string, prompt = DEFAULT_CODEX_PROMPT): CodexSmokeReport {
  const health = checkCodexConfig(repoRoot);
  const runtimeCommandPath = canonicalCodexMcpEntry(repoRoot).command;
  const runtimeExecutable = isExecutableFile(runtimeCommandPath);
  const commands = buildCodexCommands(repoRoot, prompt);
  return {
    client: "codex",
    repo_root: repoRoot,
    config_state: health.state,
    config_path: health.path,
    runtime_command_path: runtimeCommandPath,
    runtime_command_executable: runtimeExecutable,
    ready_to_smoke: health.state === "ok" && runtimeExecutable,
    caveat:
      "Current Codex CLI may not load project .codex/config.toml in noninteractive exec; " +
      "these commands pass the Lodestone MCP server inline with -c.",
    codex_mcp_list_command: commands.mcpList,
    codex_exec_command: commands.exec,
  };
}

export function buildClaudeCodeSmokeReport(
  repoRoot: string,
  prompt = DEFAULT_CLAUDE_CODE_PROMPT
): ClaudeCodeSmokeReport {
  const health = checkMcpJson(repoRoot);
  const runtimeCommandPath = path.join(repoRoot, ".lodestone", "runtime", "lodestone-mcp");
  const runtimeExecutable = isExecutableFile(runtimeCommandPath);
  const commands = buildClaudeCodeCommands(repoRoot, health.path, prompt);
  return {
    client: "claude-code",
    repo_root: repoRoot,
    config_state: health.state,
    config_path: health.path,
    runtime_command_path: runtimeCommandPath,
    runtime_command_executable: runtimeExecutable,
    ready_to_smoke: health.state === "ok" && runtimeExecutable,
    caveat:
      "Claude Code may require project MCP approval for implicit .mcp.json loading; " +
      "these commands use --mcp-config with --strict-mcp-config for a disposable proof.",
    claude_mcp_list_command: commands.mcpList,
    claude_print_command: commands.print,
  };
}

export async function buildMcpSmokeReport(
  repoRoot: string,
  handshakeRunner: McpHandshakeRunner = runMcpStdioHandshake,
  timeoutMs = 15000
): Promise<McpSmokeReport> {
  const health = checkMcpJson(repoRoot);
  const defaultRuntimeCommandPath = path.join(repoRoot, ".lodestone", "runtime", "lodestone-mcp");
  let launchConfig: McpLaunchConfig = {
    commandPath: defaultRuntimeCommandPath,
    commandArgs: [],
    commandEnv: {},
  };
  let launchConfigError: string | undefined;
  if (health.state === "ok") {
    try {
      launchConfig = readMcpLaunchConfig(repoRoot);
    } catch (err) {
      launchConfigError = err instanceof Error ? err.message : String(err);
    }
  }
  const runtimeExecutable = isExecutableFile(launchConfig.commandPath);
  const base = {
    client: "mcp" as const,
    repo_root: repoRoot,
    config_state: health.state,
    config_path: health.path,
    runtime_command_path: launchConfig.commandPath,
    runtime_command_executable: runtimeExecutable,
    caveat:
      "Direct stdio MCP smoke launches the repo-local Lodestone server and lists tools; " +
      "it does not prove a specific editor loads .mcp.json or clears that editor's trust prompts.",
  };

  const healthError = health.state !== "ok" && "detail" in health ? `${health.state}: ${health.detail}` : undefined;
  if (health.state !== "ok" || !runtimeExecutable || launchConfigError !== undefined) {
    return {
      ...base,
      handshake_attempted: false,
      handshake_ok: false,
      tool_count: 0,
      tool_names: [],
      handshake_error: launchConfigError ?? healthError,
      ready_to_smoke: false,
    };
  }

  const result = await handshakeRunner({
    repoRoot,
    commandPath: launchConfig.commandPath,
    commandArgs: launchConfig.commandArgs,
    commandEnv: launchConfig.commandEnv,
    timeoutMs,
  });
  if (!result.ok) {
    return {
      ...base,
      handshake_attempted: true,
      handshake_ok: false,
      tool_count: 0,
      tool_names: [],
      handshake_error: result.error,
      ready_to_smoke: false,
    };
  }

  return {
    ...base,
    handshake_attempted: true,
    handshake_ok: true,
    protocol_version: result.protocolVersion,
    server_name: result.serverName,
    server_version: result.serverVersion,
    tool_count: result.toolNames.length,
    tool_names: result.toolNames,
    ready_to_smoke: result.toolNames.length > 0,
  };
}

function parseClientValue(value: string, opts: ClientSmokeOptions): void {
  const normalized = value.trim().toLowerCase();
  if (normalized === "codex" || normalized === "claude-code" || normalized === "mcp") {
    opts.client = normalized;
  } else {
    opts.clientError = `Unknown client smoke target: ${value} (supported: codex, claude-code, mcp)`;
  }
}

function printCodexSmokeReport(report: CodexSmokeReport): void {
  output.info("lodestone client-smoke");
  output.info(`  client           ${report.client}`);
  output.info(`  repo root        ${report.repo_root}`);
  output.info(`  codex config     ${report.config_state} (${report.config_path})`);
  output.info(
    `  runtime command  ${report.runtime_command_executable ? "ok" : "missing-or-not-executable"} (${report.runtime_command_path})`
  );
  if (!report.ready_to_smoke) {
    output.error(
      "Codex smoke prerequisites are not healthy. Run `lodestone init --client codex --no-reindex` first."
    );
    return;
  }
  output.info("");
  output.info("Codex MCP list command:");
  output.info(`  ${report.codex_mcp_list_command}`);
  output.info("");
  output.info("Codex exec smoke command for a trusted disposable repo:");
  output.info(`  ${report.codex_exec_command}`);
  output.warn(report.caveat);
}

function printClaudeCodeSmokeReport(report: ClaudeCodeSmokeReport): void {
  output.info("lodestone client-smoke");
  output.info(`  client           ${report.client}`);
  output.info(`  repo root        ${report.repo_root}`);
  output.info(`  mcp json         ${report.config_state} (${report.config_path})`);
  output.info(
    `  runtime command  ${report.runtime_command_executable ? "ok" : "missing-or-not-executable"} (${report.runtime_command_path})`
  );
  if (!report.ready_to_smoke) {
    output.error(
      "Claude Code smoke prerequisites are not healthy. Run `lodestone init --client mcp --no-reindex` first."
    );
    return;
  }
  output.info("");
  output.info("Claude Code MCP list command:");
  output.info(`  ${report.claude_mcp_list_command}`);
  output.info("");
  output.info("Claude Code print-mode smoke command for a trusted disposable repo:");
  output.info(`  ${report.claude_print_command}`);
  output.warn(report.caveat);
}

function printMcpSmokeReport(report: McpSmokeReport): void {
  output.info("lodestone client-smoke");
  output.info(`  client           ${report.client}`);
  output.info(`  repo root        ${report.repo_root}`);
  output.info(`  mcp json         ${report.config_state} (${report.config_path})`);
  output.info(
    `  runtime command  ${report.runtime_command_executable ? "ok" : "missing-or-not-executable"} (${report.runtime_command_path})`
  );
  if (!report.handshake_attempted) {
    output.error(
      report.handshake_error ??
        "Generic MCP smoke prerequisites are not healthy. Run `lodestone init --client mcp --no-reindex` first."
    );
    return;
  }
  output.info(
    `  stdio handshake  ${report.handshake_ok ? "ok" : "failed"} (${report.tool_count} tools)`
  );
  if (report.protocol_version !== undefined) {
    output.info(`  protocol         ${report.protocol_version}`);
  }
  if (report.server_name !== undefined || report.server_version !== undefined) {
    output.info(
      `  server           ${report.server_name ?? "unknown"} ${report.server_version ?? "unknown"}`
    );
  }
  if (!report.ready_to_smoke) {
    output.error(
      report.handshake_error === undefined
        ? "Generic MCP smoke did not return any tools."
        : `Generic MCP smoke failed: ${report.handshake_error}`
    );
    return;
  }
  output.info("");
  output.info("MCP tools listed by the repo-local Lodestone server:");
  for (const name of report.tool_names) {
    output.info(`  - ${name}`);
  }
  output.warn(report.caveat);
}

function buildCodexCommands(repoRoot: string, prompt: string): { mcpList: string; exec: string } {
  const overrides = codexConfigOverrides(repoRoot);
  const overrideArgs = overrides.flatMap((override) => ["-c", override]);
  const mcpList = ["codex", "mcp", "list", ...overrideArgs].map(shellQuote).join(" ");
  const exec = [
    "codex",
    "exec",
    "-C",
    repoRoot,
    "--ignore-user-config",
    ...overrideArgs,
    "--dangerously-bypass-approvals-and-sandbox",
    "--dangerously-bypass-hook-trust",
    "--json",
    "--",
    prompt,
  ].map(shellQuote).join(" ");
  return { mcpList, exec };
}

function buildClaudeCodeCommands(repoRoot: string, configPath: string, prompt: string): { mcpList: string; print: string } {
  const mcpList = [
    "claude",
    "--mcp-config",
    configPath,
    "--strict-mcp-config",
    "mcp",
    "list",
  ].map(shellQuote).join(" ");
  const print = [
    "claude",
    "-p",
    "--mcp-config",
    configPath,
    "--strict-mcp-config",
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    "mcp__lodestone-mcp__query",
    "--disallowedTools",
    "Bash",
    "Read",
    "Edit",
    "Write",
    "Glob",
    "Grep",
    "--no-session-persistence",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--",
    prompt,
  ].map(shellQuote).join(" ");
  return { mcpList, print };
}

function codexConfigOverrides(repoRoot: string): string[] {
  const entry = canonicalCodexMcpEntry(repoRoot);
  return [
    `mcp_servers.lodestone-mcp.command=${JSON.stringify(entry.command)}`,
    "mcp_servers.lodestone-mcp.args=[]",
    `mcp_servers.lodestone-mcp.cwd=${JSON.stringify(entry.cwd)}`,
  ];
}

async function runMcpStdioHandshake({
  repoRoot,
  commandPath,
  commandArgs,
  commandEnv,
  timeoutMs,
}: {
  repoRoot: string;
  commandPath: string;
  commandArgs: string[];
  commandEnv: Record<string, string>;
  timeoutMs: number;
}): Promise<McpHandshakeResult> {
  return await new Promise<McpHandshakeResult>((resolve) => {
    const child = spawn(commandPath, commandArgs, {
      cwd: repoRoot,
      env: { ...process.env, ...commandEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let finished = false;
    let stdoutBuffer = "";
    let stderr = "";
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const waiters = new Map<
      number,
      {
        resolve: (message: JsonRpcObject) => void;
        reject: (err: Error) => void;
      }
    >();

    const finish = (result: McpHandshakeResult): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      waiters.clear();
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      child.stdin?.removeAllListeners("error");
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, 500);
      }
      resolve(result);
    };

    const fail = (message: string): void => {
      const stderrDetail = stderr.trim();
      const error = new Error(stderrDetail.length > 0 ? `${message}; stderr: ${stderrDetail}` : message);
      for (const waiter of waiters.values()) {
        waiter.reject(error);
      }
      waiters.clear();
      finish({
        ok: false,
        error: error.message,
      });
    };

    const timer = setTimeout(() => {
      fail(`MCP stdio handshake timed out after ${timeoutMs}ms`);
    }, timeoutMs);
    timer.unref();

    const writeMessage = (message: JsonRpcObject): void => {
      child.stdin?.write(`${JSON.stringify(message)}\n`);
    };

    const request = (id: number, method: string, params: Record<string, unknown>): Promise<JsonRpcObject> =>
      new Promise((requestResolve, requestReject) => {
        waiters.set(id, { resolve: requestResolve, reject: requestReject });
        writeMessage({ jsonrpc: "2.0", id, method, params });
      });

    child.on("error", (err) => {
      fail(`Failed to start MCP server: ${err.message}`);
    });
    child.on("exit", (code, signal) => {
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
        killTimer = undefined;
      }
      if (!finished) {
        fail(`MCP server exited before handshake completed (code ${code ?? "null"}, signal ${signal ?? "null"})`);
      }
    });
    child.stdin?.on("error", (err) => {
      fail(`Failed to write to MCP server stdin: ${err.message}`);
    });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < 4000) stderr += chunk;
    });
    child.stdout?.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      while (true) {
        const newline = stdoutBuffer.indexOf("\n");
        if (newline === -1) break;
        const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line.trim() === "") continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch (err) {
          fail(`MCP server wrote invalid JSON-RPC: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
        if (!isJsonRpcObject(parsed)) {
          fail("MCP server wrote a non-object JSON-RPC message");
          return;
        }
        if (typeof parsed.id !== "number" || !isJsonRpcResponse(parsed)) continue;
        const waiter = waiters.get(parsed.id);
        if (waiter === undefined) continue;
        waiters.delete(parsed.id);
        waiter.resolve(parsed);
      }
    });

    void (async () => {
      try {
        const initialized = await request(1, "initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: {
            name: "lodestone-client-smoke",
            version: "0.1.x",
          },
        });
        if (isJsonRpcError(initialized)) {
          fail(`MCP initialize failed: ${formatJsonRpcError(initialized.error)}`);
          return;
        }
        const initResult = isJsonRpcObject(initialized.result) ? initialized.result : {};
        const serverInfo = isJsonRpcObject(initResult.serverInfo) ? initResult.serverInfo : {};
        writeMessage({
          jsonrpc: "2.0",
          method: "notifications/initialized",
          params: {},
        });

        const tools = await request(2, "tools/list", {});
        if (isJsonRpcError(tools)) {
          fail(`MCP tools/list failed: ${formatJsonRpcError(tools.error)}`);
          return;
        }
        finish({
          ok: true,
          protocolVersion:
            typeof initResult.protocolVersion === "string" ? initResult.protocolVersion : undefined,
          serverName: typeof serverInfo.name === "string" ? serverInfo.name : undefined,
          serverVersion: typeof serverInfo.version === "string" ? serverInfo.version : undefined,
          toolNames: extractToolNames(tools.result),
        });
      } catch (err) {
        fail(`MCP stdio handshake failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  });
}

type JsonRpcObject = Record<string, unknown>;

function isJsonRpcObject(value: unknown): value is JsonRpcObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRpcError(value: JsonRpcObject): value is JsonRpcObject & { error: unknown } {
  return value.error !== undefined;
}

function isJsonRpcResponse(value: JsonRpcObject): boolean {
  return Object.prototype.hasOwnProperty.call(value, "result") || Object.prototype.hasOwnProperty.call(value, "error");
}

function extractToolNames(result: unknown): string[] {
  if (!isJsonRpcObject(result) || !Array.isArray(result.tools)) return [];
  const names: string[] = [];
  for (const tool of result.tools) {
    if (isJsonRpcObject(tool) && typeof tool.name === "string") names.push(tool.name);
  }
  return names.sort();
}

function formatJsonRpcError(error: unknown): string {
  if (!isJsonRpcObject(error)) return String(error);
  const code = typeof error.code === "number" ? `code ${error.code}` : "code unknown";
  const message = typeof error.message === "string" ? error.message : JSON.stringify(error);
  return `${code}: ${message}`;
}

function readMcpLaunchConfig(repoRoot: string): McpLaunchConfig {
  const cfgPath = path.join(repoRoot, ".mcp.json");
  const raw = JSON.parse(readFileSync(cfgPath, "utf8")) as unknown;
  if (!isJsonRpcObject(raw) || !isJsonRpcObject(raw.mcpServers)) {
    throw new Error(".mcp.json must contain an object mcpServers field");
  }
  const entry = raw.mcpServers[MCP_SERVER_NAME];
  if (!isJsonRpcObject(entry) || typeof entry.command !== "string") {
    throw new Error(`.mcp.json ${MCP_SERVER_NAME} entry must contain a command string`);
  }

  const commandArgs =
    entry.args === undefined
      ? []
      : Array.isArray(entry.args) && entry.args.every((arg) => typeof arg === "string")
        ? entry.args
        : undefined;
  if (commandArgs === undefined) {
    throw new Error(`.mcp.json ${MCP_SERVER_NAME} args must be an array of strings`);
  }

  const commandEnv: Record<string, string> = {};
  if (entry.env !== undefined) {
    if (!isJsonRpcObject(entry.env)) {
      throw new Error(`.mcp.json ${MCP_SERVER_NAME} env must be an object with string values`);
    }
    for (const [key, value] of Object.entries(entry.env)) {
      if (typeof value !== "string") {
        throw new Error(`.mcp.json ${MCP_SERVER_NAME} env must be an object with string values`);
      }
      commandEnv[key] = value;
    }
  }

  return { commandPath: entry.command, commandArgs, commandEnv };
}

function isExecutableFile(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  try {
    const stat = statSync(filePath);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=\-[\]]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

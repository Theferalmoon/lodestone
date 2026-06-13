// SPDX-License-Identifier: Apache-2.0
// Client compatibility smoke helpers. The command is intentionally no-mutation
// by default: it validates generated project config and prints exact commands
// a maintainer can run in a trusted/disposable repo.
import { existsSync, statSync } from "node:fs";
import { canonicalCodexMcpEntry, checkCodexConfig } from "../install/codex-config.js";
import { output } from "../ui/output.js";

export interface ClientSmokeOptions {
  client: "codex";
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

const DEFAULT_CODEX_PROMPT =
  "Use the Lodestone MCP query tool from this project to find a known symbol. " +
  "Do not use shell commands, direct file reads, or SQLite. Reply compact JSON " +
  "with used_lodestone_tool, symbol_name, and path.";

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
      "  lodestone client-smoke --client codex --json",
      "",
      "OPTIONS",
      "  --client codex      Validate the Codex adapter and emit inline MCP smoke commands.",
      "  --prompt <text>     Prompt to embed in the emitted Codex exec command.",
      "  --json              Emit one machine-readable report.",
      "  -h, --help          Show this help message.",
      "",
      "NOTES",
      "  The command does not edit Codex global config and does not run Codex.",
      "  The emitted Codex exec command is intended for a trusted disposable smoke repo.",
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
  const report = buildCodexSmokeReport(repoRoot, opts.prompt);
  if (opts.json) {
    output.json(report);
  } else {
    printCodexSmokeReport(report);
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

function parseClientValue(value: string, opts: ClientSmokeOptions): void {
  const normalized = value.trim().toLowerCase();
  if (normalized !== "codex") {
    opts.clientError = `Unknown client smoke target: ${value} (supported: codex)`;
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

function codexConfigOverrides(repoRoot: string): string[] {
  const entry = canonicalCodexMcpEntry(repoRoot);
  return [
    `mcp_servers.lodestone-mcp.command=${JSON.stringify(entry.command)}`,
    "mcp_servers.lodestone-mcp.args=[]",
    `mcp_servers.lodestone-mcp.cwd=${JSON.stringify(entry.cwd)}`,
  ];
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

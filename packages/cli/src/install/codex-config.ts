// SPDX-License-Identifier: Apache-2.0
// Project-local Codex MCP config merge for `lodestone init --client codex`.
// Codex loads `.codex/config.toml` only for trusted projects; this module only
// writes the documented config shape and leaves trust decisions to Codex.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { pathsEqual } from "../path-equal.js";
import { writeFileAtomic } from "./atomic.js";

export interface CodexConfigResult {
  action: "created" | "merged" | "updated";
  path: string;
}

export type CodexConfigHealth =
  | { state: "missing-file"; path: string }
  | { state: "missing-entry"; path: string }
  | { state: "ok"; path: string }
  | { state: "stale"; path: string; detail: string }
  | { state: "invalid"; path: string; detail: string }
  | { state: "unparseable"; path: string; detail: string };

interface TomlObject {
  [key: string]: unknown;
}

interface CodexMcpServerEntry {
  command: string;
  args: string[];
  cwd: string;
  enabled: boolean;
}

export const CODEX_SERVER_NAME = "lodestone-mcp";

function isPlainObject(value: unknown): value is TomlObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function canonicalCodexMcpEntry(repoRoot: string): CodexMcpServerEntry {
  return {
    command: path.join(repoRoot, ".lodestone", "runtime", "lodestone-mcp"),
    args: [],
    cwd: repoRoot,
    enabled: true,
  };
}

export function codexConfigPath(repoRoot: string): string {
  return path.join(repoRoot, ".codex", "config.toml");
}

export function writeCodexConfig(repoRoot: string): CodexConfigResult {
  const cfgPath = codexConfigPath(repoRoot);
  const canonicalEntry = canonicalCodexMcpEntry(repoRoot);

  if (!existsSync(cfgPath)) {
    const body = stringifyToml({
      mcp_servers: {
        [CODEX_SERVER_NAME]: canonicalEntry,
      },
    });
    writeFileAtomic(cfgPath, body);
    return { action: "created", path: cfgPath };
  }

  const existing = readCodexToml(cfgPath);
  const mcpServersRaw = existing.mcp_servers;
  const mcpServers: TomlObject =
    mcpServersRaw === undefined ? {} : asObject(mcpServersRaw, "mcp_servers");
  const had = Object.prototype.hasOwnProperty.call(mcpServers, CODEX_SERVER_NAME);
  mcpServers[CODEX_SERVER_NAME] = canonicalEntry;
  existing.mcp_servers = mcpServers;
  writeFileAtomic(cfgPath, stringifyToml(existing));
  return { action: had ? "updated" : "merged", path: cfgPath };
}

export function checkCodexConfig(repoRoot: string): CodexConfigHealth {
  const cfgPath = codexConfigPath(repoRoot);
  if (!existsSync(cfgPath)) {
    return { state: "missing-file", path: cfgPath };
  }

  let existing: TomlObject;
  try {
    existing = readCodexToml(cfgPath);
  } catch (err) {
    return {
      state: "unparseable",
      path: cfgPath,
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  if (existing.mcp_servers === undefined) {
    return { state: "missing-entry", path: cfgPath };
  }

  let mcpServers: TomlObject;
  try {
    mcpServers = asObject(existing.mcp_servers, "mcp_servers");
  } catch (err) {
    return {
      state: "invalid",
      path: cfgPath,
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const entry = mcpServers[CODEX_SERVER_NAME];
  if (entry === undefined) {
    return { state: "missing-entry", path: cfgPath };
  }
  if (!isPlainObject(entry)) {
    return {
      state: "invalid",
      path: cfgPath,
      detail: `${CODEX_SERVER_NAME} must be a TOML table/object`,
    };
  }

  const expected = canonicalCodexMcpEntry(repoRoot);
  const mismatches: string[] = [];
  if (typeof entry.command !== "string" || !pathsEqual(entry.command, expected.command)) {
    mismatches.push("command");
  }
  if (entry.args !== undefined && (!Array.isArray(entry.args) || entry.args.length !== 0)) {
    mismatches.push("args");
  }
  if (typeof entry.cwd !== "string" || !pathsEqual(entry.cwd, expected.cwd)) {
    mismatches.push("cwd");
  }
  if (entry.enabled !== undefined && entry.enabled !== expected.enabled) {
    mismatches.push("enabled");
  }

  if (mismatches.length > 0) {
    return {
      state: "stale",
      path: cfgPath,
      detail: `mismatched ${mismatches.join(", ")}`,
    };
  }

  return { state: "ok", path: cfgPath };
}

function readCodexToml(cfgPath: string): TomlObject {
  const raw = readFileSync(cfgPath, "utf8");
  let parsed: unknown;
  try {
    parsed = parseToml(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse existing .codex/config.toml: ${detail}`);
  }
  return asObject(parsed, ".codex/config.toml");
}

function asObject(value: unknown, label: string): TomlObject {
  if (!isPlainObject(value)) {
    throw new Error(`${label} must be a TOML table/object`);
  }
  return value;
}

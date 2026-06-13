// SPDX-License-Identifier: Apache-2.0
// Reverse the project-local Codex MCP config entry created by
// `lodestone init --client codex`. Conservative and manifest-scoped: only
// removes the entry when its command matches this repo's runtime shim.
import { existsSync, readFileSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import path from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import type { CodexConfigResult } from "../install/codex-config.js";
import { CODEX_SERVER_NAME, codexConfigPath } from "../install/codex-config.js";
import { writeFileAtomic } from "../install/atomic.js";
import { pathsEqual } from "../path-equal.js";

export type RemoveCodexConfigResult =
  | { action: "removed"; path: string }
  | { action: "removed-file"; path: string }
  | { action: "noop"; path: string }
  | { action: "respected-provenance"; path: string }
  | { action: "unparseable"; path: string; detail: string };

interface TomlObject {
  [key: string]: unknown;
}

function isPlainObject(value: unknown): value is TomlObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function removeCodexConfigEntry(
  repoRoot: string,
  manifest: CodexConfigResult | null | undefined,
  opts: { dryRun: boolean; expectedRuntimeCommand: string }
): RemoveCodexConfigResult {
  const cfgPath = codexConfigPath(repoRoot);
  if (!existsSync(cfgPath)) {
    return { action: "noop", path: cfgPath };
  }

  let root: TomlObject;
  try {
    root = readCodexToml(cfgPath);
  } catch (err) {
    return {
      action: "unparseable",
      path: cfgPath,
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const mcpServers = root.mcp_servers;
  if (!isPlainObject(mcpServers)) {
    return { action: "noop", path: cfgPath };
  }

  const entry = mcpServers[CODEX_SERVER_NAME];
  if (!isPlainObject(entry)) {
    return { action: "noop", path: cfgPath };
  }
  if (
    typeof entry.command !== "string" ||
    !pathsEqual(entry.command, opts.expectedRuntimeCommand)
  ) {
    return { action: "respected-provenance", path: cfgPath };
  }

  if (opts.dryRun) {
    return manifest?.action === "created"
      ? { action: "removed-file", path: cfgPath }
      : { action: "removed", path: cfgPath };
  }

  delete mcpServers[CODEX_SERVER_NAME];
  if (Object.keys(mcpServers).length === 0) {
    delete root.mcp_servers;
  }

  if (manifest?.action === "created" && Object.keys(root).length === 0) {
    rmSync(cfgPath, { force: true });
    removeEmptyParentDirectory(cfgPath);
    return { action: "removed-file", path: cfgPath };
  }

  writeFileAtomic(cfgPath, stringifyToml(root));
  return { action: "removed", path: cfgPath };
}

function removeEmptyParentDirectory(cfgPath: string): void {
  const parent = path.dirname(cfgPath);
  try {
    if (readdirSync(parent).length === 0) {
      rmdirSync(parent);
    }
  } catch {
    // Best-effort cleanup only. The important deletion is config.toml.
  }
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
  if (!isPlainObject(parsed)) {
    throw new Error(".codex/config.toml must be a TOML table/object");
  }
  return parsed;
}

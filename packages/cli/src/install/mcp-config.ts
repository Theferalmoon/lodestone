// SPDX-License-Identifier: Apache-2.0
// Idempotent .mcp.json merge for `lodestone init`. Writes the lodestone-mcp
// entry pointing at an absolute path under `<repoRoot>/.lodestone/runtime/`.
// The absolute path is the security feature: a teammate who clones the repo
// (with .mcp.json committed) but skips `lodestone init` sees Claude Code's
// "MCP server not found" error rather than silent execution of an
// attacker-controlled script. claude-plan.md §11.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathsEqual } from "../path-equal.js";
import { writeFileAtomic } from "./atomic.js";

export interface McpConfigResult {
  /**
   * - `created`: the file did not exist; we wrote one with just the
   *   lodestone-mcp entry.
   * - `merged`: the file existed but had no lodestone-mcp entry; we added
   *   one alongside the existing entries.
   * - `updated`: the file existed and already had a lodestone-mcp entry;
   *   we replaced it with the canonical (current) one.
   */
  action: "created" | "merged" | "updated";
  /** Absolute path to the written .mcp.json. */
  path: string;
}

interface McpServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

interface McpServerEntryCandidate {
  command?: unknown;
  args?: unknown;
  env?: unknown;
}

export type McpJsonHealth =
  | { state: "missing-file"; path: string }
  | { state: "missing-entry"; path: string }
  | { state: "ok"; path: string }
  | { state: "stale"; path: string; detail: string }
  | { state: "invalid"; path: string; detail: string }
  | { state: "unparseable"; path: string; detail: string };

interface McpJsonShape {
  mcpServers: Record<string, McpServerEntryCandidate>;
}

/** The runtime entry script path (relative to .lodestone/). The script itself
 * is created by §05/§13; this module only writes the absolute-path reference. */
const RUNTIME_ENTRY_REL = path.join("runtime", "lodestone-mcp");
export const MCP_SERVER_NAME = "lodestone-mcp";

function mcpJsonPath(repoRoot: string): string {
  return path.join(repoRoot, ".mcp.json");
}

function canonicalMcpServerEntry(repoRoot: string): McpServerEntry {
  return {
    command: path.join(repoRoot, ".lodestone", RUNTIME_ENTRY_REL),
    args: [],
    env: {},
  };
}

/**
 * Create or update `.mcp.json` at the repo root with the lodestone-mcp entry.
 *
 * - Creates the file if absent.
 * - Merges into an existing config without removing any other server entries.
 * - Replaces a stale lodestone-mcp entry (e.g., absolute path from a prior
 *   install on a different machine) with the current canonical entry.
 * - The `command` field is always an absolute path under
 *   `<repoRoot>/.lodestone/runtime/lodestone-mcp`. Cloners-without-init
 *   then see Claude Code's clean "MCP server not found" error rather than
 *   silent execution.
 *
 * Output formatting policy: parse → structural mutation → JSON.stringify with
 * 2-space indent + trailing newline. Friend's tab/3-space formatting is
 * normalized; tests pin this so the policy is explicit.
 *
 * Throws if `.mcp.json` exists but is not parseable JSON. We do not silently
 * overwrite a friend's broken file — better to surface the error.
 */
export function writeMcpJson(repoRoot: string): McpConfigResult {
  const canonicalEntry = canonicalMcpServerEntry(repoRoot);
  const cfgPath = mcpJsonPath(repoRoot);

  if (!existsSync(cfgPath)) {
    const body: McpJsonShape = { mcpServers: { [MCP_SERVER_NAME]: canonicalEntry } };
    writeFileAtomic(cfgPath, `${JSON.stringify(body, null, 2)}\n`);
    return { action: "created", path: cfgPath };
  }

  const existing = readMcpJson(cfgPath);
  const had = MCP_SERVER_NAME in existing.mcpServers;
  // Replacing-in-place via property assignment preserves the existing key
  // position when it's already present; otherwise the new key is appended.
  // Byte-identity across re-runs relies on V8 preserving insertion order for
  // `JSON.parse`+`JSON.stringify` (which it does, but the JSON spec does not
  // guarantee — see `mcp-config.test.ts` "idempotent" assertion which pins
  // the byte-equal invariant on the runtime we ship).
  existing.mcpServers[MCP_SERVER_NAME] = canonicalEntry;
  writeFileAtomic(cfgPath, `${JSON.stringify(existing, null, 2)}\n`);
  return { action: had ? "updated" : "merged", path: cfgPath };
}

export function checkMcpJson(repoRoot: string): McpJsonHealth {
  const cfgPath = mcpJsonPath(repoRoot);
  if (!existsSync(cfgPath)) {
    return { state: "missing-file", path: cfgPath };
  }

  let existing: McpJsonShape;
  try {
    existing = readMcpJson(cfgPath);
  } catch (err) {
    return {
      state: "unparseable",
      path: cfgPath,
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const entry = existing.mcpServers[MCP_SERVER_NAME];
  if (entry === undefined) {
    return { state: "missing-entry", path: cfgPath };
  }
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return {
      state: "invalid",
      path: cfgPath,
      detail: `${MCP_SERVER_NAME} must be a JSON object`,
    };
  }

  const expected = canonicalMcpServerEntry(repoRoot);
  const invalidFields: string[] = [];
  if (typeof entry.command !== "string" || !pathsEqual(entry.command, expected.command)) {
    return {
      state: "stale",
      path: cfgPath,
      detail: "mismatched command",
    };
  }
  if (
    entry.args !== undefined &&
    (!Array.isArray(entry.args) || entry.args.some((arg) => typeof arg !== "string"))
  ) {
    invalidFields.push("args");
  }
  if (
    entry.env !== undefined &&
    (typeof entry.env !== "object" ||
      entry.env === null ||
      Array.isArray(entry.env) ||
      Object.values(entry.env).some((value) => typeof value !== "string"))
  ) {
    invalidFields.push("env");
  }

  if (invalidFields.length > 0) {
    return {
      state: "invalid",
      path: cfgPath,
      detail: `invalid ${invalidFields.join(", ")}`,
    };
  }

  return { state: "ok", path: cfgPath };
}

function readMcpJson(p: string): McpJsonShape {
  const raw = readFileSync(p, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse existing .mcp.json: ${detail}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(".mcp.json must be a JSON object");
  }
  const shape = parsed as Partial<McpJsonShape>;
  if (shape.mcpServers === undefined) {
    // Tolerate older shapes where `mcpServers` is missing — promote into the
    // canonical structure.
    return { mcpServers: {} };
  }
  // Reject anything that is not a plain object. `Array.isArray` is checked
  // explicitly because `typeof [] === "object"`; assigning a string property
  // to an array silently no-ops under JSON.stringify, which would let
  // `lodestone init` claim a successful merge while writing a config without
  // a `lodestone-mcp` entry. Codex §04 RED #1.
  if (
    typeof shape.mcpServers !== "object" ||
    shape.mcpServers === null ||
    Array.isArray(shape.mcpServers)
  ) {
    throw new Error(".mcp.json `mcpServers` field must be an object");
  }
  return { mcpServers: shape.mcpServers as Record<string, McpServerEntryCandidate> };
}

// SPDX-License-Identifier: Apache-2.0
// Idempotent .mcp.json merge for `lodestone init`. Writes the lodestone-mcp
// entry pointing at an absolute path under `<repoRoot>/.lodestone/runtime/`.
// The absolute path is the security feature: a teammate who clones the repo
// (with .mcp.json committed) but skips `lodestone init` sees Claude Code's
// "MCP server not found" error rather than silent execution of an
// attacker-controlled script. claude-plan.md §11.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
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

interface McpJsonShape {
  mcpServers: Record<string, McpServerEntry>;
}

/** The runtime entry script path (relative to .lodestone/). The script itself
 * is created by §05/§13; this module only writes the absolute-path reference. */
const RUNTIME_ENTRY_REL = path.join("runtime", "lodestone-mcp");

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
  const absRuntimeEntry = path.join(repoRoot, ".lodestone", RUNTIME_ENTRY_REL);
  const canonicalEntry: McpServerEntry = {
    command: absRuntimeEntry,
    args: [],
    env: {},
  };

  const mcpJsonPath = path.join(repoRoot, ".mcp.json");

  if (!existsSync(mcpJsonPath)) {
    const body: McpJsonShape = { mcpServers: { "lodestone-mcp": canonicalEntry } };
    writeFileAtomic(mcpJsonPath, `${JSON.stringify(body, null, 2)}\n`);
    return { action: "created", path: mcpJsonPath };
  }

  const existing = readMcpJson(mcpJsonPath);
  const had = "lodestone-mcp" in existing.mcpServers;
  // Replacing-in-place via property assignment preserves the existing key
  // position when it's already present; otherwise the new key is appended.
  // Byte-identity across re-runs relies on V8 preserving insertion order for
  // `JSON.parse`+`JSON.stringify` (which it does, but the JSON spec does not
  // guarantee — see `mcp-config.test.ts` "idempotent" assertion which pins
  // the byte-equal invariant on the runtime we ship).
  existing.mcpServers["lodestone-mcp"] = canonicalEntry;
  writeFileAtomic(mcpJsonPath, `${JSON.stringify(existing, null, 2)}\n`);
  return { action: had ? "updated" : "merged", path: mcpJsonPath };
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
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(".mcp.json must be a JSON object");
  }
  const shape = parsed as Partial<McpJsonShape>;
  if (typeof shape.mcpServers !== "object" || shape.mcpServers === null) {
    // Tolerate older shapes where `mcpServers` is missing — promote into the
    // canonical structure. Anything else (string, array) is a parse error.
    if (shape.mcpServers !== undefined) {
      throw new Error(".mcp.json `mcpServers` field must be an object");
    }
    return { mcpServers: {} };
  }
  return { mcpServers: shape.mcpServers as Record<string, McpServerEntry> };
}

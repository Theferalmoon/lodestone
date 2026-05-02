// SPDX-License-Identifier: Apache-2.0
// Inverse of `install/mcp-config.ts`. Removes the lodestone-mcp entry from
// `<repoRoot>/.mcp.json`. Preserves all other entries byte-identically (parse
// → delete one key → re-serialize with the install module's exact formatting:
// 2-space indent + trailing newline).
//
// Per spec §19 "removing the only entry": the file is left as
// `{ "mcpServers": {} }\n`, NOT deleted — preserves the friend's file
// structure and any external tooling that expects `.mcp.json` to exist.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../install/atomic.js";

export interface RemoveMcpResult {
  /**
   * - `removed`: lodestone-mcp entry was present and is now gone.
   * - `noop`: lodestone-mcp entry was absent (idempotent re-run).
   * - `missing-file`: `.mcp.json` does not exist.
   * - `unparseable`: `.mcp.json` exists but is not valid JSON; left untouched
   *   (see safety guarantee in spec — never destroy a file we can't parse).
   */
  action: "removed" | "noop" | "missing-file" | "unparseable";
  path: string;
  detail?: string;
}

const SERVER_NAME = "lodestone-mcp";

interface McpJsonShape {
  mcpServers: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Remove the `lodestone-mcp` entry from `.mcp.json`.
 *
 * - If the file does not exist → `missing-file`.
 * - If the file is not parseable → `unparseable`. The file is NOT modified.
 * - If the entry is absent → `noop`.
 * - Otherwise → `removed`. The remaining `mcpServers` map (possibly empty) is
 *   written back with 2-space indentation and a trailing newline. Other
 *   top-level fields (some MCP hosts add their own) are preserved.
 *
 * `dryRun: true` plans the same result without touching disk.
 */
export function removeMcpEntry(
  repoRoot: string,
  opts: { dryRun?: boolean } = {}
): RemoveMcpResult {
  const mcpPath = path.join(repoRoot, ".mcp.json");

  if (!existsSync(mcpPath)) {
    return { action: "missing-file", path: mcpPath };
  }

  let raw: string;
  try {
    raw = readFileSync(mcpPath, "utf8");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { action: "unparseable", path: mcpPath, detail };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { action: "unparseable", path: mcpPath, detail };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { action: "unparseable", path: mcpPath, detail: "root must be a JSON object" };
  }

  const obj = parsed as McpJsonShape;
  if (typeof obj.mcpServers !== "object" || obj.mcpServers === null) {
    // No mcpServers map at all → nothing to remove. Safe no-op.
    return { action: "noop", path: mcpPath };
  }
  if (!(SERVER_NAME in obj.mcpServers)) {
    return { action: "noop", path: mcpPath };
  }

  if (opts.dryRun === true) {
    return { action: "removed", path: mcpPath };
  }

  delete obj.mcpServers[SERVER_NAME];
  // Always preserve the file with `mcpServers` map (possibly empty `{}`) per
  // spec — never delete the file. Friend's other top-level fields survive.
  writeFileAtomic(mcpPath, `${JSON.stringify(obj, null, 2)}\n`);
  return { action: "removed", path: mcpPath };
}

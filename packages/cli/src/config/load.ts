// SPDX-License-Identifier: Apache-2.0
// Reads `.lodestone/lodestone.toml` (if present), applies env overrides,
// merges into the canonical zod schema's defaults. MUST NOT throw when the
// toml is missing — `lodestone init` runs before any config exists, and it
// calls loadConfig() before writing the toml.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { lodestoneSubpath, parseLodestoneConfig, type LodestoneConfig } from "@lodestone/shared";

/**
 * Load the parsed Lodestone config for `cwd`.
 *
 * Behavior:
 *  - No `.lodestone/lodestone.toml` → returns the schema defaults (the zod
 *    schema's defaulted-everywhere shape, with `project.name` derived from
 *    `cwd`'s basename so the defaults are usable without ceremony).
 *  - Present + parseable → parses + validates against the canonical zod schema.
 *  - Present + malformed → throws (the friend should know their config is bad).
 *
 * Env overrides — DEFERRED to §18 (privacy enforcement).
 *
 * Codex impl-003 B5 flagged the spec/implementation mismatch: the original
 * §03 spec said "apply env overrides" but `LodestoneConfig` has no fields
 * for `offline` or `log_level`, so smuggling them through this loader would
 * widen `LodestoneConfig` in a way that conflicts with §18's policy ownership.
 * Decision: §18 introduces a separate `RuntimeEnvOptions` type and reads
 * `LODESTONE_OFFLINE` / `LODESTONE_LOG_LEVEL` there. This loader stays
 * config-file-only.
 *
 * Implementation note: builds a fresh object instead of mutating the parsed
 * TOML in place. Callers can safely keep their own reference to the raw value.
 */
export async function loadConfig(cwd: string): Promise<LodestoneConfig> {
  const tomlPath = lodestoneSubpath(cwd, "config");

  let parsed: Record<string, unknown> = {};
  if (existsSync(tomlPath)) {
    const text = readFileSync(tomlPath, "utf8");
    parsed = parseToml(text) as Record<string, unknown>;
  }

  // Build a fresh object — never mutate the input.
  const merged: Record<string, unknown> = { ...parsed };

  const projectIn =
    merged.project && typeof merged.project === "object"
      ? (merged.project as Record<string, unknown>)
      : {};
  const projectName =
    typeof projectIn.name === "string" && projectIn.name.length > 0
      ? projectIn.name
      : path.basename(path.resolve(cwd)) || "lodestone-project";
  merged.project = { ...projectIn, name: projectName };

  return parseLodestoneConfig(merged);
}

// SPDX-License-Identifier: Apache-2.0
// Reads `.lodestone/install-manifest.json` for the uninstall flow. Returns a
// validated `InstallManifest` or `null` if the manifest is missing/unreadable.
// A missing or schema-mismatched manifest triggers conservative-mode uninstall
// (touch only `.lodestone/` and the `.mcp.json` lodestone entry).
import { existsSync, readFileSync } from "node:fs";
import { lodestoneSubpath } from "@lodestone/shared";
import type { InstallManifest } from "../commands/init.js";

export type ManifestReadResult =
  | { ok: true; manifest: InstallManifest; path: string }
  | { ok: false; reason: "missing" | "unreadable" | "invalid-json" | "schema-mismatch"; path: string; detail?: string };

/**
 * Locate and parse the install manifest at `<repoRoot>/.lodestone/install-manifest.json`.
 *
 * Validation policy (deliberately strict — uninstall makes destructive
 * decisions from this data):
 *   - File must exist and be readable.
 *   - Body must parse as JSON.
 *   - `schema_version` must equal `1`.
 *   - The three action fields (`mcp_json.action`, `claude_md.action`,
 *     `gitignore.action`) must be present strings.
 * Anything else returns `{ ok: false }` with a discriminated `reason` so the
 * caller can decide between "warn + conservative-mode" and "abort".
 */
export function readInstallManifest(repoRoot: string): ManifestReadResult {
  const manifestPath = lodestoneSubpath(repoRoot, "installManifest");

  if (!existsSync(manifestPath)) {
    return { ok: false, reason: "missing", path: manifestPath };
  }

  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: "unreadable", path: manifestPath, detail };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: "invalid-json", path: manifestPath, detail };
  }

  if (!isValidManifest(parsed)) {
    return {
      ok: false,
      reason: "schema-mismatch",
      path: manifestPath,
      detail: "expected schema_version=1 with mcp_json/claude_md/gitignore action fields",
    };
  }

  return { ok: true, manifest: parsed, path: manifestPath };
}

function isValidManifest(value: unknown): value is InstallManifest {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (obj.schema_version !== 1) return false;
  if (typeof obj.installed_at !== "string") return false;

  const mcp = obj.mcp_json as Record<string, unknown> | undefined;
  if (typeof mcp !== "object" || mcp === null) return false;
  if (typeof mcp.action !== "string") return false;

  const cm = obj.claude_md as Record<string, unknown> | undefined;
  if (typeof cm !== "object" || cm === null) return false;
  if (typeof cm.action !== "string") return false;

  const gi = obj.gitignore as Record<string, unknown> | undefined;
  if (typeof gi !== "object" || gi === null) return false;
  if (typeof gi.action !== "string") return false;

  return true;
}

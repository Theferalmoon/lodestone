// SPDX-License-Identifier: Apache-2.0
// Reads `.lodestone/install-manifest.json` for the uninstall flow. Returns a
// validated `InstallManifest` or a discriminated failure variant.
//
// Schema versions:
//   v1: original — `schema_version: 1`. Backward-compatibility kept so a
//       friend who installed with an older binary can still uninstall.
//       Treated as `install_state: "complete"` and `reindex_state: undefined`.
//   v2: adds `install_state: "pending" | "complete"` and an optional
//       `reindex_state: "complete" | "failed" | "skipped"`. See §04
//       transactional-install design.
//
// Future-schema policy (Codex §19 YELLOW): if the on-disk manifest declares
// a `schema_version` STRICTLY GREATER than what this binary supports
// (`MAX_SUPPORTED_SCHEMA_VERSION`), the read returns a `future-schema`
// failure. The uninstall handler then REFUSES to delete `.lodestone/` so an
// older uninstaller never shreds a newer install's state. The user is told
// to upgrade.
import { existsSync, readFileSync } from "node:fs";
import { lodestoneSubpath } from "@lodestone/shared";
import type { InstallManifest } from "../commands/init.js";

/** Highest `schema_version` this binary can validate end-to-end. */
export const MAX_SUPPORTED_SCHEMA_VERSION = 2;

export type ManifestReadResult =
  | { ok: true; manifest: InstallManifest; path: string }
  | {
      ok: false;
      reason:
        | "missing"
        | "unreadable"
        | "invalid-json"
        | "schema-mismatch"
        | "future-schema";
      path: string;
      detail?: string;
    };

/**
 * Locate and parse the install manifest at `<repoRoot>/.lodestone/install-manifest.json`.
 *
 * Validation policy (deliberately strict — uninstall makes destructive
 * decisions from this data):
 *   - File must exist and be readable.
 *   - Body must parse as JSON.
 *   - `schema_version` must be a known version (1 or 2) up to
 *     `MAX_SUPPORTED_SCHEMA_VERSION`. Versions strictly greater than that
 *     return a `future-schema` failure (see Codex §19 YELLOW).
 *   - The three action fields (`mcp_json.action`, `claude_md.action`,
 *     `gitignore.action`) must be present strings.
 *
 * v1 manifests are normalized to the v2 in-memory shape: `install_state`
 * defaults to `"complete"` (v1 only wrote a manifest if install succeeded).
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

  // Future-schema check FIRST — before structural validation. Newer
  // manifests may legitimately have additional required fields this binary
  // does not know about, and we must not even attempt to parse them.
  if (typeof parsed === "object" && parsed !== null) {
    const v = (parsed as { schema_version?: unknown }).schema_version;
    if (typeof v === "number" && v > MAX_SUPPORTED_SCHEMA_VERSION) {
      return {
        ok: false,
        reason: "future-schema",
        path: manifestPath,
        detail: `manifest schema_version=${v} is newer than this binary supports (max=${MAX_SUPPORTED_SCHEMA_VERSION}). Upgrade lodestone before uninstalling.`,
      };
    }
  }

  const normalized = normalizeManifest(parsed);
  if (normalized === null) {
    return {
      ok: false,
      reason: "schema-mismatch",
      path: manifestPath,
      detail: `expected schema_version in [1, ${MAX_SUPPORTED_SCHEMA_VERSION}] with mcp_json/claude_md/gitignore action fields`,
    };
  }

  return { ok: true, manifest: normalized, path: manifestPath };
}

/**
 * Validate + upgrade an on-disk manifest to the current in-memory shape.
 * Returns null if the manifest fails structural validation. v1 manifests
 * are upgraded to v2 with `install_state: "complete"` (a v1 manifest only
 * existed on disk if the install reached the final write step).
 */
function normalizeManifest(value: unknown): InstallManifest | null {
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Record<string, unknown>;

  const schemaVersion = obj.schema_version;
  if (schemaVersion !== 1 && schemaVersion !== 2) return null;
  if (typeof obj.installed_at !== "string") return null;

  const mcp = obj.mcp_json as Record<string, unknown> | undefined;
  if (typeof mcp !== "object" || mcp === null) return null;
  if (typeof mcp.action !== "string") return null;

  const cm = obj.claude_md as Record<string, unknown> | undefined;
  if (typeof cm !== "object" || cm === null) return null;
  if (typeof cm.action !== "string") return null;

  const gi = obj.gitignore as Record<string, unknown> | undefined;
  if (typeof gi !== "object" || gi === null) return null;
  if (typeof gi.action !== "string") return null;

  // Upgrade v1 → v2 in-memory. v1 had no `install_state` field because
  // v1 only wrote the manifest at the END of a successful install.
  let installState: InstallManifest["install_state"];
  if (schemaVersion === 1) {
    installState = "complete";
  } else {
    const s = obj.install_state;
    if (s !== "pending" && s !== "complete") return null;
    installState = s;
  }

  let reindexState: InstallManifest["reindex_state"];
  if (schemaVersion === 2 && obj.reindex_state !== undefined) {
    const r = obj.reindex_state;
    if (r !== "complete" && r !== "failed" && r !== "skipped") return null;
    reindexState = r;
  }

  let codexConfig: InstallManifest["codex_config"] | undefined;
  if (obj.codex_config !== undefined) {
    if (typeof obj.codex_config !== "object" || obj.codex_config === null) return null;
    const cc = obj.codex_config as Record<string, unknown>;
    if (typeof cc.action !== "string" || !["created", "merged", "updated"].includes(cc.action)) return null;
    if (typeof cc.path !== "string") return null;
    codexConfig = cc as unknown as InstallManifest["codex_config"];
  }

  return {
    schema_version: 2,
    installed_at: obj.installed_at,
    install_state: installState,
    ...(reindexState !== undefined ? { reindex_state: reindexState } : {}),
    mcp_json: mcp as unknown as InstallManifest["mcp_json"],
    claude_md: cm as unknown as InstallManifest["claude_md"],
    gitignore: gi as unknown as InstallManifest["gitignore"],
    ...(codexConfig !== undefined ? { codex_config: codexConfig } : {}),
  };
}

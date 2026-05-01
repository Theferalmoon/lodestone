// SPDX-License-Identifier: Apache-2.0
// Canonical path resolver for `.lodestone/`. Single source of truth for every
// section that reads or writes anything under the project-local index dir.
import path from "node:path";
import fs from "node:fs";

export const LODESTONE_DIRNAME = ".lodestone";

/**
 * Map of typed subpath keys → relative path components.
 * The map (not arbitrary strings) is what makes `lodestoneSubpath` traversal-safe.
 *
 * NOTE: per the POST-CODEX-001 amendments, the storage substrate is SQLite
 * (better-sqlite3 in WAL mode), NOT KuzuDB. The original section spec body
 * referenced `kuzu`, `feedback`, `version` keys; those are renamed here to
 * `sqlite`, `ready` per claude-plan.md §1.3 and §1.5.
 *
 * Codex impl-002 D2: the previous `feedbackJsonl` key was removed. Per
 * claude-plan.md §4.8, feedback persists to the SQLite `feedback` table —
 * the JSONL surface invited drift back to the deprecated storage path.
 */
const SUBPATHS = {
  lance: "lance",
  sqlite: "lodestone.sqlite",
  models: "models",
  skills: "skills",
  seedSkills: path.join("skills", "seed"),
  emergingSkills: path.join("skills", "emerging"),
  archiveSkills: path.join("skills", ".archive"),
  runtime: "runtime",
  ready: "ready.json",
  config: "lodestone.toml",
  installManifest: "install-manifest.json",
} as const;

export type LodestoneSubpathKey = keyof typeof SUBPATHS;

/**
 * Returns `<cwd>/.lodestone`. Ensures `<cwd>` exists (mkdir -p), but does NOT
 * create `.lodestone` itself — that's the caller's responsibility (so callers
 * who only want to *read* don't accidentally create stale dirs).
 */
export function canonicalLodestoneDir(cwd: string): string {
  const dir = path.join(cwd, LODESTONE_DIRNAME);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  return dir;
}

/**
 * Returns `<cwd>/.lodestone/<sub>` for a known subpath key.
 *
 * Throws if `name` is not a known key. Accepting only typed enum keys (rather
 * than free-form strings) gives us both compile-time safety and runtime
 * traversal protection — there's no way for a caller to slip in `..` or an
 * absolute path.
 */
export function lodestoneSubpath(cwd: string, name: LodestoneSubpathKey): string {
  if (!Object.prototype.hasOwnProperty.call(SUBPATHS, name)) {
    throw new Error(`Unknown lodestone subpath key: ${String(name)}`);
  }
  return path.join(canonicalLodestoneDir(cwd), SUBPATHS[name]);
}

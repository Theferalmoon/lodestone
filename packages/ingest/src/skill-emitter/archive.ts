// SPDX-License-Identifier: Apache-2.0
// Lodestone — moves expired SKILL.md cards to .archive/ (does not delete).

import { cp, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import { parseFrontmatter } from "./frontmatter.js";

export interface ArchiveConfig {
  /** Absolute path to `.lodestone/`. */
  lodestoneDir: string;
  /** Default 60. */
  expireDays?: number;
}

export interface ArchiveResult {
  movedCount: number;
  movedPaths: string[];
  /** Slugs whose frontmatter could not be parsed; left in place. */
  skipped: string[];
}

const DEFAULT_EXPIRE_DAYS = 60;
const SCAN_SOURCES = ["seed", "emerging", "observed"] as const;
const ARCHIVE_DIR = ".archive";

/**
 * Walk `.lodestone/skills/{seed,emerging,observed}/<slug>/SKILL.md`. For each
 * card whose frontmatter `emitted_at` is older than `expireDays`, move the
 * entire `<slug>/` directory to `.lodestone/skills/.archive/<slug>/`.
 *
 * Move semantics: prefer `fs.rename`; on `EXDEV` (cross-device), fall back
 * to recursive copy + remove. NEVER deletes — friends can recover archived
 * skills by hand.
 *
 * Re-archive collisions: when `.archive/<slug>` already exists, append a
 * numeric suffix `<slug>-2`, `<slug>-3`, ... until a free name is found.
 *
 * Files with malformed frontmatter are skipped (and surfaced via the
 * `skipped` array for caller logging).
 */
export async function expireOld(
  cfg: ArchiveConfig,
  now: Date = new Date(),
): Promise<ArchiveResult> {
  const expireDays = cfg.expireDays ?? DEFAULT_EXPIRE_DAYS;
  const expireMs = expireDays * 24 * 60 * 60 * 1000;
  const skillsRoot = path.join(cfg.lodestoneDir, "skills");
  const archiveRoot = path.join(skillsRoot, ARCHIVE_DIR);

  const movedPaths: string[] = [];
  const skipped: string[] = [];

  for (const source of SCAN_SOURCES) {
    const sourceDir = path.join(skillsRoot, source);
    const entries = await safeReaddir(sourceDir);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const slug = entry.name;
      const slugDir = path.join(sourceDir, slug);
      const skillFile = path.join(slugDir, "SKILL.md");
      const text = await safeReadFile(skillFile);
      if (text === null) {
        // No SKILL.md inside the dir — nothing actionable, leave alone.
        continue;
      }
      const parsed = parseFrontmatter(text);
      if (!parsed) {
        skipped.push(skillFile);
        continue;
      }
      const emittedAt = Date.parse(parsed.fields.emitted_at);
      if (Number.isNaN(emittedAt)) {
        skipped.push(skillFile);
        continue;
      }
      const ageMs = now.getTime() - emittedAt;
      if (ageMs < expireMs) continue;

      const destSlug = await pickFreeName(archiveRoot, slug);
      const destDir = path.join(archiveRoot, destSlug);
      await moveDir(slugDir, destDir);
      movedPaths.push(destDir);
    }
  }

  return { movedCount: movedPaths.length, movedPaths, skipped };
}

async function safeReaddir(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function safeReadFile(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function pickFreeName(parentDir: string, baseName: string): Promise<string> {
  let candidate = baseName;
  let counter = 2;
  while (await pathExists(path.join(parentDir, candidate))) {
    candidate = `${baseName}-${counter}`;
    counter++;
  }
  return candidate;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function moveDir(src: string, dest: string): Promise<void> {
  // Ensure parent exists.
  await ensureParent(dest);
  try {
    await rename(src, dest);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
  }
  // Cross-device fallback: copy + remove. Non-atomic but the spec accepts
  // this for the rare cross-FS case.
  await cp(src, dest, { recursive: true });
  await rm(src, { recursive: true, force: true });
}

async function ensureParent(file: string): Promise<void> {
  const parent = path.dirname(file);
  await (await import("node:fs/promises")).mkdir(parent, { recursive: true });
}

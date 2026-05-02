// SPDX-License-Identifier: Apache-2.0
// Lodestone — disk-truth loader for SKILL.md cards.
//
// The §10 emitter writes each card to:
//   <lodestoneDir>/skills/<source>/<slug>/SKILL.md
// where source ∈ {seed, emerging, observed} (per skill-emitter/emit.ts
// EmitSource). SQLite mirrors the body for indexing, but the file on disk
// is the source of truth — friends may hand-edit cards in place. The
// `skills_for` MCP tool MUST return the file's content when present so the
// agent's response cannot disagree with the file the friend has open.
//
// Defense in depth: the slug column is set by §10 via slugify(), so under
// normal operation it is path-safe. We still assert the resolved file path
// stays under <lodestoneDir>/skills/ — never trust a slug that contains
// `..`, an absolute prefix, or a NUL byte.

import { readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Possible on-disk subdirs for a skill, in maturity-derived precedence
 * order. The §10 emitter chooses one of these per emit, but the read-side
 * doesn't strictly know which (the DB stores `maturity`, not `source`); we
 * map the two and try the matching dir, then fall through to the others
 * for forward compat (e.g., a card that was promoted from emerging→observed
 * but not yet re-emitted).
 */
const SKILL_SOURCE_DIRS = ["seed", "emerging", "observed"] as const;

/** Map a stored Maturity value to the on-disk source dir the §10 emitter
 * would have chosen. Mirrors `sourceToMaturity` from
 * @lodestone/ingest/skill-emitter (which lives in a sibling package — kept
 * inline here to avoid a runtime dep on ingest from mcp-server). */
function maturityToSourceDir(maturity: string): string {
  if (maturity === "deterministic_seed") return "seed";
  if (maturity === "observed") return "observed";
  return "emerging"; // covers "emerging" + any future intermediate value
}

/**
 * Try to load the on-disk SKILL.md body for a (slug, maturity) pair. Returns
 * `null` when:
 *   - the resolved path would escape `<lodestoneDir>/skills/` (slug traversal)
 *   - the file does not exist or is unreadable
 *   - the file is empty
 *   - any I/O error fires (e.g., permission denied)
 *
 * Callers fall back to the SQLite body when this returns null. The function
 * never throws — disk problems are best-effort signal, not a hard error.
 *
 * Returns the FULL file content (frontmatter + body). The §10 emitter writes
 * `${frontmatter}${body}`, so the on-disk text is what the friend sees in
 * their editor; agents reading the body get the same view.
 */
export function readSkillBodyFromDisk(
  lodestoneDir: string,
  slug: string,
  maturity: string,
): string | null {
  if (!isPathSafeSlug(slug)) return null;

  const skillsRoot = path.join(lodestoneDir, "skills");
  // Try the maturity-derived dir first, then the others (emit-source may
  // have changed since the row was last refreshed).
  const preferred = maturityToSourceDir(maturity);
  const order = [
    preferred,
    ...SKILL_SOURCE_DIRS.filter((s) => s !== preferred),
  ];

  for (const source of order) {
    const file = path.join(skillsRoot, source, slug, "SKILL.md");
    // path.resolve normalises `..` segments; if the result escapes
    // skillsRoot we abort.
    const resolved = path.resolve(file);
    const resolvedRoot = path.resolve(skillsRoot);
    if (!resolved.startsWith(resolvedRoot + path.sep) && resolved !== resolvedRoot) {
      continue;
    }
    try {
      const stat = statSync(resolved);
      if (!stat.isFile()) continue;
      const text = readFileSync(resolved, "utf8");
      if (text.length === 0) continue;
      return text;
    } catch {
      // ENOENT, EACCES, etc. — try next source dir, then fall back.
      continue;
    }
  }
  return null;
}

/**
 * Reject slugs that could escape the skills root when joined to a path.
 * Bans `..` segments, absolute paths, NUL bytes, and any path separator
 * that would split the slug into multiple segments. The §10 slugify()
 * already lower-cases + alpha-num-dashes a slug, so a real production
 * slug always passes; this is the read-side guardrail against a corrupted
 * or hand-edited DB row.
 */
function isPathSafeSlug(slug: string): boolean {
  if (slug.length === 0) return false;
  if (slug.includes("\0")) return false;
  if (slug.includes("/") || slug.includes("\\")) return false;
  if (slug === "." || slug === "..") return false;
  if (path.isAbsolute(slug)) return false;
  // Cheap belt-and-braces: the resolved single-segment slug must equal itself
  // after normalization.
  if (path.normalize(slug) !== slug) return false;
  return true;
}

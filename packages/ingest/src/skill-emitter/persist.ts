// SPDX-License-Identifier: Apache-2.0
// Lodestone — persist Skill rows into the §08 SQLite `skills` table.
// SQLite is the source of truth (POST-CODEX-001 amendment 1); the on-disk
// SKILL.md is a human-readable mirror.

import type Database from "better-sqlite3";

import type { Skill, SkillRow } from "@lodestone/shared";

export interface PersistResult {
  written: number;
  unchanged: number;
}

/**
 * Insert or update one Skill row keyed by `id`. Idempotency is delegated to
 * the caller — the row's `body_sha256` is the conflict-detection hook the
 * emitter uses on disk; we record whatever value is supplied.
 *
 * `description_embedding` is left NULL — §10 does not embed; an embedder
 * pass (run separately) backfills the column for `skills_for()` cosine
 * search.
 */
export function writeSkill(db: Database.Database, skill: Skill, opts: {
  body_sha256: string;
  expires_at?: string | null;
}): "inserted" | "updated" | "unchanged" {
  const existing = db
    .prepare("SELECT body_sha256 FROM skills WHERE id = ?")
    .get(skill.id) as { body_sha256: string } | undefined;
  if (existing && existing.body_sha256 === opts.body_sha256) {
    return "unchanged";
  }

  const row: SkillRow = {
    id: skill.id,
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    description_embedding: null,
    body: skill.body,
    source_cluster_id: skill.source_cluster_id ?? null,
    maturity: skill.maturity,
    confidence: skill.confidence,
    evidence_count: skill.evidence_count,
    observed_days: skill.observed_days,
    emitted_at: skill.emitted_at,
    expires_at: opts.expires_at ?? null,
    body_sha256: opts.body_sha256,
  };

  const stmt = db.prepare(
    `INSERT INTO skills (
       id, slug, name, description, description_embedding,
       body, source_cluster_id, maturity, confidence,
       evidence_count, observed_days, emitted_at, expires_at, body_sha256
     ) VALUES (
       @id, @slug, @name, @description, @description_embedding,
       @body, @source_cluster_id, @maturity, @confidence,
       @evidence_count, @observed_days, @emitted_at, @expires_at, @body_sha256
     )
     ON CONFLICT(id) DO UPDATE SET
       slug = excluded.slug,
       name = excluded.name,
       description = excluded.description,
       body = excluded.body,
       source_cluster_id = excluded.source_cluster_id,
       maturity = excluded.maturity,
       confidence = excluded.confidence,
       evidence_count = excluded.evidence_count,
       observed_days = excluded.observed_days,
       emitted_at = excluded.emitted_at,
       expires_at = excluded.expires_at,
       body_sha256 = excluded.body_sha256`,
  );
  stmt.run(row);
  return existing ? "updated" : "inserted";
}

/**
 * Bulk-write a batch of Skill rows in a single transaction. Returns counts
 * of skill rows that were newly written (insert+update) vs. left untouched
 * because their `body_sha256` matched the existing row.
 */
export function writeSkills(
  db: Database.Database,
  skills: ReadonlyArray<{ skill: Skill; body_sha256: string; expires_at?: string | null }>,
): PersistResult {
  let written = 0;
  let unchanged = 0;
  const tx = db.transaction(() => {
    for (const entry of skills) {
      const result = writeSkill(db, entry.skill, {
        body_sha256: entry.body_sha256,
        expires_at: entry.expires_at,
      });
      if (result === "unchanged") unchanged++;
      else written++;
    }
  });
  tx();
  return { written, unchanged };
}

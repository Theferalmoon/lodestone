// SPDX-License-Identifier: Apache-2.0
// Lodestone — persist Skill rows into the §08 SQLite `skills` table.
// SQLite is the source of truth (POST-CODEX-001 amendment 1); the on-disk
// SKILL.md is a human-readable mirror.

import type Database from "better-sqlite3";

import type { Skill, SkillRow } from "@lodestone/shared";

import type { EmbedderHandle } from "../embed/runtime.js";

export interface PersistResult {
  written: number;
  unchanged: number;
}

/**
 * Insert or update one Skill row keyed by `id`. Idempotency is delegated to
 * the caller — the row's `body_sha256` is the conflict-detection hook the
 * emitter uses on disk; we record whatever value is supplied.
 *
 * If `description_embedding` is supplied, it is persisted as-is (a Buffer
 * containing the Float32Array bytes). When omitted, the column is left NULL
 * — preserves the pre-v0.1.1 behavior so callers (and tests) that don't
 * have an embedder available pay no penalty.
 */
export function writeSkill(
  db: Database.Database,
  skill: Skill,
  opts: {
    body_sha256: string;
    expires_at?: string | null;
    description_embedding?: Buffer | null;
  },
): "inserted" | "updated" | "unchanged" {
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
    description_embedding: opts.description_embedding ?? null,
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
       description_embedding = excluded.description_embedding,
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
 *
 * If `opts.embedder` is supplied, each skill's `description` is embedded in
 * a single batched call up-front (outside the transaction so we don't hold
 * a write lock during inference) and persisted as a BLOB in the
 * `skills.description_embedding` column. §16's `skills_for` cosine search
 * reads this column directly. When no embedder is supplied the column is
 * left NULL and `skills_for` falls back to substring scoring.
 */
export async function writeSkills(
  db: Database.Database,
  skills: ReadonlyArray<{ skill: Skill; body_sha256: string; expires_at?: string | null }>,
  opts: { embedder?: EmbedderHandle } = {},
): Promise<PersistResult> {
  let embeddings: (Buffer | null)[] = skills.map(() => null);
  if (opts.embedder && skills.length > 0) {
    const texts = skills.map((entry) => entry.skill.description);
    // Chunk by embedder.maxBatch — see clusterer/persist.ts for context.
    const maxBatch = Math.max(1, opts.embedder.maxBatch);
    const vectors: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += maxBatch) {
      const slice = await opts.embedder.embed(texts.slice(i, i + maxBatch));
      vectors.push(...slice);
    }
    embeddings = vectors.map((vec) =>
      vec ? Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength) : null,
    );
  }

  let written = 0;
  let unchanged = 0;
  const tx = db.transaction(() => {
    for (let i = 0; i < skills.length; i++) {
      const entry = skills[i]!;
      const result = writeSkill(db, entry.skill, {
        body_sha256: entry.body_sha256,
        expires_at: entry.expires_at,
        description_embedding: embeddings[i] ?? null,
      });
      if (result === "unchanged") unchanged++;
      else written++;
    }
  });
  tx();
  return { written, unchanged };
}

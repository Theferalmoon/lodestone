// SPDX-License-Identifier: Apache-2.0
// Skill type — emitted SKILL.md cards (deterministic_seed | emerging | observed).

/**
 * Skill maturity (post-Codex-001 framing — replaces the original `source` field).
 *
 * - `"deterministic_seed"`: emitted at install time by §11 scanners from static
 *   project structure (test conventions, error subclasses, logger imports, etc.).
 *   Useful as bootstrap content; agents should caveat that the system has not
 *   yet observed enough usage to surface emerging patterns.
 * - `"emerging"`: derived from a Louvain cluster <30 days old. Real but unstable.
 * - `"observed"`: cluster ≥30 days old with consistent membership. Most trustworthy.
 */
export type Maturity = "deterministic_seed" | "emerging" | "observed";

export interface Skill {
  id: string;
  /** Filesystem-safe name; also the SKILL.md dir name. */
  slug: string;
  name: string;
  /** 1-line summary used in `skills_for()` match preview. */
  description: string;
  /** Full SKILL.md body (markdown). */
  body: string;
  /** Pointer to the source cluster, or null for deterministic_seed skills. */
  source_cluster_id?: string;
  maturity: Maturity;
  /** 0..1 — high for seed (deterministic), variable for emerging/observed. */
  confidence: number;
  /** Number of files / sites that informed this skill. */
  evidence_count: number;
  /** Cluster age in days for emerging/observed; 0 for deterministic_seed. */
  observed_days: number;
  /** ISO-8601 timestamp. */
  emitted_at: string;
  /** Populated by `skills_for()` vector search; absent on direct reads. */
  match_score?: number;
}

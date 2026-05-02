// SPDX-License-Identifier: Apache-2.0
// Lodestone — seed-skill scanner shared types.

import type { ParseResult } from "../parsers/base.js";

/**
 * Provenance label for an emitted seed Skill — distinguishes the scanner that
 * produced it. Used by callers / observability; does NOT change the
 * `Maturity` value (which is always `"deterministic_seed"` per §10).
 */
export type SeedSkillSource =
  | "error-hierarchy"
  | "framework-detector"
  | "test-patterns"
  | "logging-patterns"
  | "config-env-patterns"
  | "persistence-patterns";

/**
 * Input passed to every scanner. `parseResults` are the §06 ParseResult
 * objects accumulated for the repo (typically one per source file). Scanners
 * MUST be pure functions: same input → same output, no I/O, no time-of-day
 * dependence. The orchestrator handles emission timestamps.
 */
export interface SeedSkillInput {
  parseResults: readonly ParseResult[];
}

/**
 * Internal scanner output shape. The orchestrator (`index.ts::seedSkillsFor`)
 * lifts these into full `Skill` records by filling in deterministic-seed
 * defaults (`maturity`, `confidence`, `observed_days`, `emitted_at`).
 *
 * Scanners are responsible for:
 * - Producing a stable, content-derived `id` (so a re-run with identical
 *   inputs yields the same Skill id — required for SQLite upserts).
 * - Choosing a slug; the orchestrator does not slugify.
 * - Rendering the markdown body.
 * - Reporting `evidence_count` (member/import-site count) and a small set of
 *   `sample_paths` (for telemetry / future ranking).
 */
export interface SeedSkillRecord {
  id: string;
  slug: string;
  name: string;
  description: string;
  body: string;
  evidence_count: number;
  sample_paths: string[];
}

/**
 * Optional configuration for the orchestrator. Today only `now` exists (so
 * tests can pin `emitted_at`). Reserved for future controls (skip-scanner
 * flags, evidence thresholds, etc.).
 */
export interface SeedSkillsConfig {
  /** Override the wall clock used for `emitted_at`. */
  now?: Date;
}

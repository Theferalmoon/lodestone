// SPDX-License-Identifier: Apache-2.0
// Lodestone — §11 seed-skills public surface.
//
// `seedSkillsFor(parseResults, config)` runs every deterministic-seed scanner
// against the parsed corpus and returns a list of `Skill` records ready to be
// persisted via the §10 emit pathway (`writeSkill` / `writeSkills`) or
// rendered to disk via the §10 `emit` SKILL.md writer.
//
// Per POST-CODEX-001 amendment §2 to spec §11: every seed Skill carries
// `maturity: "deterministic_seed"`, `confidence: 1.0`, `observed_days: 0`,
// and `source_cluster_id: undefined`.

import type { Skill } from "@lodestone/shared";

import type { ParseResult } from "../parsers/base.js";

import { detectErrorHierarchy } from "./error-hierarchy.js";
import { detectFrameworks } from "./framework-detector.js";
import { detectTestPatterns } from "./test-patterns.js";
import { detectLoggingPatterns } from "./logging-patterns.js";
import { detectConfigEnvPatterns } from "./config-env-patterns.js";
import { detectPersistencePatterns } from "./persistence-patterns.js";
import type {
  SeedSkillInput,
  SeedSkillRecord,
  SeedSkillsConfig,
  SeedSkillSource,
} from "./types.js";

/** Confidence value baked into every deterministic-seed Skill. */
export const SEED_CONFIDENCE = 1.0;

/**
 * Run all deterministic-seed scanners against the parsed corpus and lift the
 * results into full `Skill` records.
 *
 * The returned list is stable-ordered (errors first, then frameworks by
 * evidence_count desc, then by slug) so callers can rely on positional output
 * for tests / display.
 */
export function seedSkillsFor(
  parseResults: readonly ParseResult[],
  config: SeedSkillsConfig = {},
): Skill[] {
  const input: SeedSkillInput = { parseResults };
  const now = (config.now ?? new Date()).toISOString();

  const records: Array<{ source: SeedSkillSource; record: SeedSkillRecord }> = [];

  const errorRecord = detectErrorHierarchy(input);
  if (errorRecord) {
    records.push({ source: "error-hierarchy", record: errorRecord });
  }

  const testRecord = detectTestPatterns(input);
  if (testRecord) {
    records.push({ source: "test-patterns", record: testRecord });
  }

  const loggingRecord = detectLoggingPatterns(input);
  if (loggingRecord) {
    records.push({ source: "logging-patterns", record: loggingRecord });
  }

  const configRecord = detectConfigEnvPatterns(input);
  if (configRecord) {
    records.push({ source: "config-env-patterns", record: configRecord });
  }

  const persistenceRecord = detectPersistencePatterns(input);
  if (persistenceRecord) {
    records.push({ source: "persistence-patterns", record: persistenceRecord });
  }

  const frameworkRecords = detectFrameworks(input);
  for (const record of frameworkRecords) {
    records.push({ source: "framework-detector", record });
  }

  return records.map(({ record }) => recordToSkill(record, now));
}

function recordToSkill(record: SeedSkillRecord, emittedAtIso: string): Skill {
  return {
    id: record.id,
    slug: record.slug,
    name: record.name,
    description: record.description,
    body: record.body,
    // Per §10 Skill shape: source_cluster_id is optional and intentionally
    // absent for deterministic-seed entries (no source cluster).
    source_cluster_id: undefined,
    maturity: "deterministic_seed",
    confidence: SEED_CONFIDENCE,
    evidence_count: record.evidence_count,
    observed_days: 0,
    emitted_at: emittedAtIso,
  };
}

export { detectErrorHierarchy } from "./error-hierarchy.js";
export { detectFrameworks } from "./framework-detector.js";
export { detectTestPatterns } from "./test-patterns.js";
export { detectLoggingPatterns } from "./logging-patterns.js";
export { detectConfigEnvPatterns } from "./config-env-patterns.js";
export { detectPersistencePatterns } from "./persistence-patterns.js";
export type {
  SeedSkillInput,
  SeedSkillRecord,
  SeedSkillsConfig,
  SeedSkillSource,
} from "./types.js";

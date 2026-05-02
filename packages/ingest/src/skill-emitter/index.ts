// SPDX-License-Identifier: Apache-2.0
// Lodestone — public surface for the skill emitter (§10).

export { emit, sha256Hex } from "./emit.js";
export type { EmitConfig, EmitResult, EmitSource } from "./emit.js";

export { shouldEmit } from "./selection.js";
export type { SelectionConfig, SelectionDecision, SelectionInputs } from "./selection.js";

export { expireOld } from "./archive.js";
export type { ArchiveConfig, ArchiveResult } from "./archive.js";

export { slugify } from "./slug.js";

export {
  renderFrontmatter,
  parseFrontmatter,
  sourceToMaturity,
} from "./frontmatter.js";
export type { FrontmatterFields } from "./frontmatter.js";

export {
  computeConfidence,
  observedDaysFrom,
  confidenceInputsFromCluster,
} from "./confidence.js";
export type { ConfidenceInputs } from "./confidence.js";

export { renderBody } from "./template.js";

export { writeSkill, writeSkills } from "./persist.js";
export type { PersistResult } from "./persist.js";

// Codex v0.1.1 §10/§11 YELLOW: pipeline-side helpers that drive batch
// emission of SKILL.md cards (clusters via emit(); seeds via a parallel
// helper that mirrors the §10 frontmatter shape).
export { emitClusterSkills, emitSeedSkillFiles } from "./pipeline-emit.js";
export type {
  EmitClusterSkillsResult,
  EmitClusterSkillsOptions,
  EmitSeedSkillFilesResult,
} from "./pipeline-emit.js";

// Re-export types consumers commonly need.
export type { Skill, Maturity } from "@lodestone/shared";

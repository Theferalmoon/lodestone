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

// Re-export types consumers commonly need.
export type { Skill, Maturity } from "@lodestone/shared";

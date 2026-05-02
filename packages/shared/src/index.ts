// SPDX-License-Identifier: Apache-2.0
// Public surface of @lodestone/shared. Every other package imports from here.

// Envelope
export type { LodestoneToolResponse, Provenance, Diagnostics } from "./types/envelope.js";
export { provenanceSchema, parseProvenance } from "./types/envelope.js";

// Readiness marker (.lodestone/ready.json) — Codex impl-002 D3.
export type { ReadyJson } from "./types/ready.js";
export { readyJsonSchema, parseReadyJson } from "./types/ready.js";

// Symbol / graph / cluster
export type {
  Language,
  SymbolKind,
  EdgeKind,
  Range,
  SymbolRef,
  LodestoneSymbol,
  // Alias — section spec body refers to it as `Symbol`. Note that this
  // shadows the global `Symbol` constructor for code that does
  // `import { Symbol } from "@lodestone/shared"` — most consumers should
  // prefer `LodestoneSymbol` to avoid the shadow. Both are exported.
  LodestoneSymbol as Symbol,
  Edge,
  ClassInheritance,
  NamingEvidence,
  NameStatus,
  AgentInstruction,
  ClusterDiagnostics,
  Cluster,
} from "./types/symbol.js";

// Skill
export type { Skill, Maturity } from "./types/skill.js";

// Feedback
export type { FeedbackInput, FeedbackEvent, FeedbackSignal } from "./types/feedback.js";
export { FEEDBACK_SIGNALS } from "./types/feedback.js";

// Config
export type { LodestoneConfig } from "./types/config.js";
export type { McpToolName } from "./config/schema.js";
export { lodestoneConfigSchema, parseLodestoneConfig } from "./config/schema.js";

// Paths
export {
  canonicalLodestoneDir,
  lodestoneSubpath,
  LODESTONE_DIRNAME,
} from "./paths.js";
export type { LodestoneSubpathKey } from "./paths.js";

// Net — Section 18 privacy enforcement chokepoint
export {
  assertNetworkAllowed,
  isOfflineMode,
  NetworkBlockedError,
} from "./net/fetch.js";

// Hash — Section 18 / impl-005 amendment, shared SHA256 helper
export { sha256File } from "./hash/sha256.js";

// SQLite schema (canonical row types — single source of truth for §08+)
export type {
  BoolInt,
  SchemaVersionRow,
  SymbolRow,
  EdgeRow,
  ClassInheritanceRow,
  ClusterRow,
  ClusterMemberRow,
  SkillRow,
  FeedbackRow,
  IndexMetaRow,
  LodestoneSchema,
  LodestoneTableName,
} from "./schema/index.js";
export { LODESTONE_TABLES, CURRENT_SCHEMA_VERSION } from "./schema/index.js";

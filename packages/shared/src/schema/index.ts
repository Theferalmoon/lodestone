// SPDX-License-Identifier: Apache-2.0
// Canonical SQLite schema TypeScript types. Producer: §08 (DDL); consumers:
// §07 (writes via ingest), §09 (clusterer), §10 (skill emitter), §11 (seed),
// §13–§17 (MCP tools). Single source of truth — every package imports from here.
//
// These types match the canonical DDL in claude-plan.md §1.3 field-for-field.
// SQLite has no native boolean — we use 0|1 ints in the DB and `BoolInt` here.
//
// Wire vs storage shape: some application-level types (e.g. `Cluster`) carry
// fields that are required, while the SQLite row equivalent is nullable (the
// row may be inserted before the field is computed). §08 owns the read-side
// map that fills missing values with sensible defaults before constructing
// the application-level type.
import type { FeedbackSignal } from "../types/feedback.js";
import type { Maturity } from "../types/skill.js";
import type { Language, NameStatus, SymbolKind, EdgeKind } from "../types/symbol.js";

export type BoolInt = 0 | 1;

export interface SchemaVersionRow {
  version: number;
  /** ISO-8601 */
  applied_at: string;
}

export interface SymbolRow {
  /** Canonical fully-qualified id, e.g. "src/auth.ts::User::login". */
  id: string;
  path: string;
  language: Language;
  kind: SymbolKind;
  range_start_line: number;
  range_end_line: number;
  signature: string | null;
  docstring: string | null;
  pagerank: number | null;
  cluster_id: string | null;
  /** Last commit that touched this symbol. */
  updated_at_commit: string | null;
  /** index_epoch when this row was written. */
  updated_at_epoch: number;
}

export interface EdgeRow {
  from_id: string;
  to_id: string;
  kind: EdgeKind;
  weight: number;
}

export interface ClassInheritanceRow {
  class_id: string;
  base_name: string;
  base_path: string | null;
}

export interface ClusterRow {
  /** Stable hash of sorted-member-ids + algorithm name. */
  id: string;
  name: string;
  /**
   * Application-level Cluster.name_status union. SQLite stores it as TEXT;
   * the row type narrows to the union so consumer reads stay type-safe at
   * the boundary.
   */
  name_status: NameStatus;
  /**
   * Application-level Cluster.description is required (string); ClusterRow
   * keeps this nullable because the row may be inserted before the auto-summary
   * is computed. §08's read-side map fills `description: ""` (or omits the
   * cluster from results) before constructing the application-level Cluster.
   */
  description: string | null;
  /**
   * Nomic-text-v1.5 vector for `cluster()` semantic-fallback search.
   * SQLite BLOB → Node Buffer (which is a Uint8Array subclass).
   */
  description_embedding: Buffer | null;
  size: number;
  algorithm: "louvain" | "leiden";
  algorithm_version: string;
  /**
   * Application-level ClusterDiagnostics.modularity is required; ClusterRow
   * keeps this nullable because not every clustering algorithm reports a
   * modularity score. §08's read-side map omits the diagnostic field when null.
   */
  modularity: number | null;
  index_epoch: number;
}

export interface ClusterMemberRow {
  cluster_id: string;
  symbol_id: string;
  /** SQLite has no boolean; 1 = symbol has cross-cluster edges, 0 = doesn't. */
  is_bridge: BoolInt;
}

export interface SkillRow {
  id: string;
  /** Filesystem-safe, also the SKILL.md dir name. */
  slug: string;
  name: string;
  description: string;
  /** Nomic-text-v1.5 vector for `skills_for()` cosine search. */
  description_embedding: Buffer | null;
  /** Full SKILL.md body as markdown. */
  body: string;
  /** Pointer to the source cluster, or NULL for deterministic_seed skills. */
  source_cluster_id: string | null;
  maturity: Maturity;
  /** 0..1 — high for seed (deterministic), variable for emerging/observed. */
  confidence: number;
  evidence_count: number;
  observed_days: number;
  /** ISO-8601 */
  emitted_at: string;
  /** ISO-8601; NULL = no expiry. */
  expires_at: string | null;
  /** SHA-256 of body for idempotency check. */
  body_sha256: string;
}

export interface FeedbackRow {
  id: number;
  /** ISO-8601 */
  recorded_at: string;
  tool: string;
  request_id: string;
  /**
   * Codex impl-002 B5: narrowed from `string` to the `FeedbackSignal` union.
   * SQLite still stores TEXT; the row type narrows at the type-system boundary.
   * §08 owns the runtime check that decodes/validates the literal on read.
   */
  signal: FeedbackSignal;
  note: string | null;
}

/**
 * Maps each table name to its row type. Lets call sites parameterize on the
 * table name (e.g. by §13's read-only client wrappers) and get the right row
 * shape without per-table boilerplate.
 */
export interface LodestoneSchema {
  schema_version: SchemaVersionRow;
  symbols: SymbolRow;
  edges: EdgeRow;
  class_inheritance: ClassInheritanceRow;
  clusters: ClusterRow;
  cluster_members: ClusterMemberRow;
  skills: SkillRow;
  feedback: FeedbackRow;
}

/** Names of every table in the canonical schema. Useful for migration drivers. */
export const LODESTONE_TABLES = [
  "schema_version",
  "symbols",
  "edges",
  "class_inheritance",
  "clusters",
  "cluster_members",
  "skills",
  "feedback",
] as const;

export type LodestoneTableName = (typeof LODESTONE_TABLES)[number];

/** Current schema version (matches the row `bootstrap()` writes). */
export const CURRENT_SCHEMA_VERSION = 1;

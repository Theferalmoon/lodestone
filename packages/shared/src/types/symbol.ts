// SPDX-License-Identifier: Apache-2.0
// Symbol/Edge/Cluster types — graph + cluster surface used by every consumer section.

export type Language = "typescript" | "javascript" | "python" | "go" | "rust";

export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "const"
  | "module";

export type EdgeKind = "calls" | "imports" | "extends" | "implements";

export interface Range {
  start_line: number;
  end_line: number;
}

export interface SymbolRef {
  /** Canonical fully-qualified id: e.g. "src/auth.ts::User::login". */
  symbol: string;
  path: string;
  range: Range;
  /** Populated when ranking is requested (callers/callees lists, impact, cluster members). */
  pagerank?: number;
}

export interface LodestoneSymbol {
  /** Canonical fully-qualified id (matches `SymbolRef.symbol`). */
  symbol: string;
  path: string;
  range: Range;
  language: Language;
  kind: SymbolKind;
  /** Best-effort declaration text (one line). */
  signature?: string;
  /** Leading comment block, if any. */
  docstring?: string;
  /** Membership pointer; null if symbol hasn't been clustered yet. */
  cluster_id?: string;
}

export interface Edge {
  from: string;
  to: string;
  kind: EdgeKind;
  /** Aggregated weight when the same (from, to, kind) appears multiple times. */
  weight?: number;
}

/** Class-inheritance triple — produced by §06 parsers, consumed by §11 error-hierarchy scanner. */
export interface ClassInheritance {
  class_id: string;
  base_name: string;
  base_path?: string;
}

/** Heuristic-naming evidence surfaced to agents in `cluster()` responses. */
export interface NamingEvidence {
  /** Most common verb extracted from member names (stoplisted). */
  dominant_verb?: string;
  /** Highest-PageRank symbol in the cluster (used as the anchor for the heuristic name). */
  anchor_symbol: string;
  /** How many members were sampled for naming. */
  members_sampled: number;
}

/** Marker for whether the cluster name was heuristic-generated or human-edited. */
export type NameStatus = "heuristic" | "human";

/** Hint to the agent: should it re-name based on members, or treat as authoritative? */
export type AgentInstruction = "synthesize_name_from_members" | "use_as_is";

/** Diagnostics surfaced in `cluster()` responses so agents can detect a degraded run. */
export interface ClusterDiagnostics {
  /** "louvain" today; "leiden" reserved for v0.5+ Pro mode. */
  algorithm: "louvain" | "leiden";
  algorithm_version: string;
  resolution: number;
  seed: number;
  graph_node_count: number;
  graph_edge_count: number;
  modularity: number;
  singleton_count: number;
  bridge_count: number;
  /** Stable hash of sorted member-symbol-ids; changes only when membership changes. */
  stability_hash: string;
}

export interface Cluster {
  id: string;
  name: string;
  name_status: NameStatus;
  agent_instruction: AgentInstruction;
  naming_evidence: NamingEvidence;
  description: string;
  size: number;
  /** PageRank-ordered, capped per request granularity. */
  members: SymbolRef[];
  /** Cross-cluster connector symbols. */
  bridges: SymbolRef[];
  /**
   * Pointer to the SKILL.md card emitted from this cluster, if any.
   *
   * NOTE: this field has no direct column on `ClusterRow` — at read time, §16
   * derives it via JOIN with `skills.source_cluster_id`. Keep this field on the
   * application-level type; storage shape stays normalized.
   */
  emitted_skill_id?: string;
  diagnostics: ClusterDiagnostics;
}

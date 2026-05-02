// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  CURRENT_SCHEMA_VERSION,
  LODESTONE_TABLES,
  type LodestoneSchema,
  type LodestoneTableName,
  type SymbolRow,
  type ClusterRow,
  type SkillRow,
} from "./index.js";

describe("Canonical SQLite schema (post-Codex-001 single source of truth)", () => {
  it("CURRENT_SCHEMA_VERSION is 3 (impl-008 fixup: index_meta + class_inheritance composite key)", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(3);
  });

  it("LODESTONE_TABLES includes the 9 canonical tables in DDL order", () => {
    expect([...LODESTONE_TABLES]).toEqual([
      "schema_version",
      "symbols",
      "edges",
      "class_inheritance",
      "clusters",
      "cluster_members",
      "skills",
      "feedback",
      "index_meta",
    ]);
  });

  it("LodestoneTableName matches the LODESTONE_TABLES values", () => {
    const t: LodestoneTableName = "symbols";
    expect(LODESTONE_TABLES).toContain(t);
  });

  it("SymbolRow shape matches DDL — fields nullable as documented", () => {
    const sym: SymbolRow = {
      id: "src/auth.ts::User::login",
      path: "src/auth.ts",
      language: "typescript",
      kind: "method",
      range_start_line: 12,
      range_end_line: 28,
      signature: null,
      docstring: null,
      pagerank: null,
      cluster_id: null,
      updated_at_commit: null,
      updated_at_epoch: 1,
    };
    expect(sym.signature).toBeNull();
  });

  it("ClusterRow has post-Codex name_status field + nullable description_embedding", () => {
    const c: ClusterRow = {
      id: "auth-cluster-01",
      name: "login-User",
      name_status: "heuristic",
      description: null,
      description_embedding: null,
      size: 14,
      algorithm: "louvain",
      algorithm_version: "graphology-communities-louvain@2.0.4",
      modularity: null,
      index_epoch: 1,
    };
    expect(c.name_status).toBe("heuristic");
    expect(c.description_embedding).toBeNull();
  });

  it("SkillRow has post-Codex maturity field + body_sha256 idempotency hash", () => {
    const s: SkillRow = {
      id: "seed-error-handling",
      slug: "error-handling",
      name: "Custom Error Subclass Pattern",
      description: "How errors are modeled.",
      description_embedding: null,
      body: "# Custom Error Subclass Pattern\n\n…",
      source_cluster_id: null,
      maturity: "deterministic_seed",
      confidence: 1.0,
      evidence_count: 8,
      observed_days: 0,
      emitted_at: "2026-05-01T03:00:00Z",
      expires_at: null,
      body_sha256: "abc123...",
    };
    expect(s.maturity).toBe("deterministic_seed");
    expect(s.body_sha256).toBeDefined();
  });

  it("LodestoneSchema maps each table name to its row type (compile-time check)", () => {
    type ExpectSymbolMatch = LodestoneSchema["symbols"] extends SymbolRow ? true : false;
    type ExpectSkillMatch = LodestoneSchema["skills"] extends SkillRow ? true : false;
    const a: ExpectSymbolMatch = true;
    const b: ExpectSkillMatch = true;
    expect(a && b).toBe(true);
  });
});

// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import type {
  LodestoneSymbol,
  Edge,
  Cluster,
  ClassInheritance,
  NamingEvidence,
  ClusterDiagnostics,
} from "./symbol.js";

describe("Symbol/Edge/Cluster types", () => {
  it("LodestoneSymbol: representative shape", () => {
    const s: LodestoneSymbol = {
      symbol: "src/auth.ts::User::login",
      path: "src/auth.ts",
      range: { start_line: 12, end_line: 28 },
      language: "typescript",
      kind: "method",
      signature: "async login(email: string, password: string): Promise<Session>",
      docstring: "Validates credentials and returns a session.",
      cluster_id: "auth-cluster-01",
    };
    expect(s).toMatchSnapshot();
  });

  it("Edge: weight is optional + kind enum", () => {
    const e: Edge = { from: "a", to: "b", kind: "calls" };
    const e2: Edge = { from: "a", to: "b", kind: "imports", weight: 2.5 };
    expect(e.weight).toBeUndefined();
    expect(e2.weight).toBe(2.5);
  });

  it("ClassInheritance triple", () => {
    const ci: ClassInheritance = {
      class_id: "src/errors.ts::AuthError",
      base_name: "AppError",
      base_path: "src/errors.ts",
    };
    expect(ci.base_path).toBe("src/errors.ts");
  });

  it("Cluster: post-Codex shape (name_status, agent_instruction, naming_evidence, diagnostics)", () => {
    const naming_evidence: NamingEvidence = {
      dominant_verb: "login",
      anchor_symbol: "src/auth.ts::User::login",
      members_sampled: 12,
    };
    const diagnostics: ClusterDiagnostics = {
      algorithm: "louvain",
      algorithm_version: "graphology-communities-louvain@2.0.4",
      resolution: 1.5,
      seed: 42,
      graph_node_count: 200,
      graph_edge_count: 800,
      modularity: 0.62,
      singleton_count: 3,
      bridge_count: 5,
      stability_hash: "sha256-abc...",
    };
    const c: Cluster = {
      id: "auth-cluster-01",
      name: "login-User",
      name_status: "heuristic",
      agent_instruction: "synthesize_name_from_members",
      naming_evidence,
      description: "Authentication subsystem clustered around the User entity.",
      size: 14,
      members: [],
      bridges: [],
      diagnostics,
    };
    expect(c).toMatchSnapshot();
  });

  it("Cluster does NOT have the legacy raw_for_llm_synthesis field (post-Codex amendment)", () => {
    // Type-level regression guard: if anyone re-adds raw_for_llm_synthesis to
    // the Cluster interface, this expression fails to type-check.
    type HasRaw = "raw_for_llm_synthesis" extends keyof Cluster ? true : false;
    const noRaw: HasRaw = false;
    expect(noRaw).toBe(false);
  });
});

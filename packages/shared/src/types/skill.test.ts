// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import type { Skill, Maturity } from "./skill.js";

describe("Skill type (post-Codex maturity field)", () => {
  it("exposes the three Maturity values", () => {
    const allowed: Maturity[] = ["deterministic_seed", "emerging", "observed"];
    expect(allowed).toHaveLength(3);
    expect(allowed).toContain("deterministic_seed");
  });

  it("seed skill snapshot — deterministic_seed, no source_cluster_id", () => {
    const seed: Skill = {
      id: "seed-error-handling",
      slug: "error-handling",
      name: "Custom Error Subclass Pattern",
      description: "How this codebase models domain errors via Error subclasses.",
      body: "# Custom Error Subclass Pattern\n\n…",
      maturity: "deterministic_seed",
      confidence: 1.0,
      evidence_count: 8,
      observed_days: 0,
      emitted_at: "2026-05-01T03:00:00Z",
    };
    expect(seed.source_cluster_id).toBeUndefined();
    expect(seed).toMatchSnapshot();
  });

  it("emerging skill carries source_cluster_id + observed_days > 0", () => {
    const emerging: Skill = {
      id: "emerging-auth-cluster-01",
      slug: "auth-flow",
      name: "Auth flow",
      description: "Auto-derived from a stable cluster the index has watched.",
      body: "# Auth flow\n\n…",
      source_cluster_id: "auth-cluster-01",
      maturity: "emerging",
      confidence: 0.78,
      evidence_count: 14,
      observed_days: 12,
      emitted_at: "2026-05-13T03:00:00Z",
    };
    expect(emerging.source_cluster_id).toBe("auth-cluster-01");
    expect(emerging.observed_days).toBeGreaterThan(0);
  });
});

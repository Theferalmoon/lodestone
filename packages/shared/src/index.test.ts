// SPDX-License-Identifier: Apache-2.0
// Public surface tests — verify the package barrel exports everything
// downstream sections rely on. Catches accidental drops at refactor time.
import { describe, it, expect, expectTypeOf } from "vitest";
import {
  // Schema constants
  CURRENT_SCHEMA_VERSION,
  LODESTONE_TABLES,
  // Path utilities
  canonicalLodestoneDir,
  lodestoneSubpath,
  LODESTONE_DIRNAME,
  // Config schema
  lodestoneConfigSchema,
  parseLodestoneConfig,
  // Provenance validator
  provenanceSchema,
  parseProvenance,
  // Feedback signals
  FEEDBACK_SIGNALS,
} from "./index.js";

import type {
  // Envelope
  LodestoneToolResponse,
  Provenance,
  Diagnostics,
  // Symbol/graph (incl. the alias)
  LodestoneSymbol,
  Symbol as LodestoneSymbolAlias, // alias re-export per spec body
  Edge,
  Cluster,
  Range,
  // Skill
  Skill,
  Maturity,
  // Feedback
  FeedbackInput,
  FeedbackEvent,
  // Config
  LodestoneConfig,
  // Schema row types
  SymbolRow,
  ClusterRow,
  SkillRow,
} from "./index.js";

describe("@lodestone/shared public surface", () => {
  it("exports all runtime values consumer sections need", () => {
    expect(CURRENT_SCHEMA_VERSION).toBeTypeOf("number");
    expect(Array.isArray(LODESTONE_TABLES)).toBe(true);
    expect(LODESTONE_DIRNAME).toBe(".lodestone");
    expect(typeof canonicalLodestoneDir).toBe("function");
    expect(typeof lodestoneSubpath).toBe("function");
    expect(typeof parseLodestoneConfig).toBe("function");
    expect(typeof parseProvenance).toBe("function");
    expect(provenanceSchema).toBeDefined();
    expect(lodestoneConfigSchema).toBeDefined();
    expect([...FEEDBACK_SIGNALS].length).toBeGreaterThan(0);
  });

  it("Symbol is an alias of LodestoneSymbol (per spec body literal usage)", () => {
    // If the alias is broken, this `extends` fails to compile.
    type AliasMatches = LodestoneSymbolAlias extends LodestoneSymbol ? true : false;
    type ReverseMatches = LodestoneSymbol extends LodestoneSymbolAlias ? true : false;
    const fwd: AliasMatches = true;
    const rev: ReverseMatches = true;
    expect(fwd && rev).toBe(true);
  });

  it("type imports compile (smoke)", () => {
    // Pure compile-time check — if any export is missing this file fails to type-check.
    expectTypeOf<Provenance>().toHaveProperty("is_git_repo");
    expectTypeOf<Diagnostics>().toHaveProperty("coverage");
    expectTypeOf<LodestoneToolResponse<unknown>>().toHaveProperty("request_id");
    expectTypeOf<Cluster>().toHaveProperty("name_status");
    expectTypeOf<Skill>().toHaveProperty("maturity");
    expectTypeOf<Edge>().toHaveProperty("kind");
    expectTypeOf<Range>().toHaveProperty("start_line");
    expectTypeOf<FeedbackInput>().toHaveProperty("request_id");
    expectTypeOf<FeedbackEvent>().toHaveProperty("recorded_at");
    expectTypeOf<LodestoneConfig>().toHaveProperty("project");
    expectTypeOf<SymbolRow>().toHaveProperty("path");
    expectTypeOf<ClusterRow>().toHaveProperty("name_status");
    expectTypeOf<SkillRow>().toHaveProperty("maturity");
    expectTypeOf<Maturity>().toEqualTypeOf<"deterministic_seed" | "emerging" | "observed">();
  });
});

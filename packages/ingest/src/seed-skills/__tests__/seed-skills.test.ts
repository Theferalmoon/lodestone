// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { SEED_CONFIDENCE, seedSkillsFor } from "../index.js";

import { demoCorpus, mkClassParseResult, mkImportsParseResult } from "./fixtures.js";

describe("seedSkillsFor", () => {
  it("returns no skills for an empty corpus", () => {
    expect(seedSkillsFor([])).toEqual([]);
  });

  it("emits both error and framework skills against the demo corpus", () => {
    const skills = seedSkillsFor(demoCorpus(), {
      now: new Date("2026-05-01T12:00:00Z"),
    });
    expect(skills.length).toBeGreaterThanOrEqual(2);

    // Error skill always comes first per the orchestrator's stable ordering.
    expect(skills[0]!.slug).toBe("errors");
    expect(skills[1]!.slug).toBe("framework-express");
  });

  it("tags every emitted Skill as deterministic_seed with confidence 1.0 and observed_days 0", () => {
    const skills = seedSkillsFor(demoCorpus(), {
      now: new Date("2026-05-01T12:00:00Z"),
    });
    expect(skills.length).toBeGreaterThan(0);
    for (const skill of skills) {
      expect(skill.maturity).toBe("deterministic_seed");
      expect(skill.confidence).toBe(SEED_CONFIDENCE);
      expect(skill.confidence).toBe(1.0);
      expect(skill.observed_days).toBe(0);
      expect(skill.source_cluster_id).toBeUndefined();
      expect(skill.emitted_at).toBe("2026-05-01T12:00:00.000Z");
    }
  });

  it("uses provided wall-clock for emitted_at; defaults to now() otherwise", () => {
    const before = Date.now();
    const skills = seedSkillsFor(demoCorpus());
    const after = Date.now();
    expect(skills.length).toBeGreaterThan(0);
    const t = Date.parse(skills[0]!.emitted_at);
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(after);
  });

  it("is deterministic: same input → same Skill ids and bodies on a re-run", () => {
    const corpus = demoCorpus();
    const a = seedSkillsFor(corpus, { now: new Date("2026-05-01T00:00:00Z") });
    const b = seedSkillsFor(corpus, { now: new Date("2026-05-01T00:00:00Z") });
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(a[i]!.id).toBe(b[i]!.id);
      expect(a[i]!.body).toBe(b[i]!.body);
      expect(a[i]!.slug).toBe(b[i]!.slug);
    }
  });

  it("skips the error scanner when no error family qualifies", () => {
    const skills = seedSkillsFor(
      [mkImportsParseResult("src/a.ts", ["express"]), mkImportsParseResult("src/b.ts", ["express"])],
      { now: new Date("2026-05-01T00:00:00Z") },
    );
    expect(skills).toHaveLength(1);
    expect(skills[0]!.slug).toBe("framework-express");
  });

  it("skips the framework scanner when no framework qualifies", () => {
    const skills = seedSkillsFor(
      [
        mkClassParseResult([
          { id: "src/errors.ts::A", path: "src/errors.ts", base: "Error" },
          { id: "src/errors.ts::B", path: "src/errors.ts", base: "Error" },
        ]),
      ],
      { now: new Date("2026-05-01T00:00:00Z") },
    );
    expect(skills).toHaveLength(1);
    expect(skills[0]!.slug).toBe("errors");
  });

  it("populates evidence_count and a non-empty body on every skill", () => {
    const skills = seedSkillsFor(demoCorpus(), {
      now: new Date("2026-05-01T00:00:00Z"),
    });
    for (const skill of skills) {
      expect(skill.evidence_count).toBeGreaterThan(0);
      expect(skill.body.length).toBeGreaterThan(50);
      expect(skill.name.length).toBeGreaterThan(0);
      expect(skill.description.length).toBeGreaterThan(0);
    }
  });
});

// SPDX-License-Identifier: Apache-2.0
// `skills_for` tool — §16 handler tests. Builds a temp SQLite index, seeds a
// small skills table, then exercises top_k clamping, maturity-based
// diagnostics, embedding cosine ranking, the substring fallback, and the
// POST-CODEX-001 envelope shape.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  bootstrap,
  closeDb,
  openWriter,
  writeReady,
  _resetWriterRegistry,
  writeIndexMeta,
  } from "@lodestone/ingest/store";
import type { EmbedderHandle } from "@lodestone/ingest/embed";

import { openReader } from "../client/sqlite.js";
import {
  createHandler as createSkillsForHandler,
  description as SKILLS_FOR_DESCRIPTION,
  inputSchema,
} from "../tools/skills_for.js";

interface SeedSkill {
  id: string;
  slug: string;
  name: string;
  description: string;
  body: string;
  source_cluster_id: string | null;
  maturity: "deterministic_seed" | "emerging" | "observed";
  confidence: number;
  evidence_count: number;
  observed_days: number;
  emitted_at: string;
  body_sha256: string;
  /** Optional 4-dim vector to backfill description_embedding. */
  embedding?: number[];
}

function seedFixture(dbPath: string, skills: SeedSkill[]): void {
  const w = openWriter(dbPath);
  bootstrap(w);
  writeIndexMeta(w, 1, { id: "nomic-text-v1.5", dim: 768, quant: "fp32" });
  const insert = w.prepare(
    `INSERT INTO skills (id, slug, name, description, description_embedding,
        body, source_cluster_id, maturity, confidence, evidence_count,
        observed_days, emitted_at, expires_at, body_sha256)
       VALUES (@id, @slug, @name, @description, @description_embedding,
        @body, @source_cluster_id, @maturity, @confidence, @evidence_count,
        @observed_days, @emitted_at, NULL, @body_sha256)`,
  );
  const tx = w.transaction(() => {
    for (const s of skills) {
      let buf: Buffer | null = null;
      if (s.embedding) {
        buf = Buffer.alloc(s.embedding.length * 4);
        for (let i = 0; i < s.embedding.length; i += 1) {
          buf.writeFloatLE(s.embedding[i]!, i * 4);
        }
      }
      insert.run({
        id: s.id,
        slug: s.slug,
        name: s.name,
        description: s.description,
        description_embedding: buf,
        body: s.body,
        source_cluster_id: s.source_cluster_id,
        maturity: s.maturity,
        confidence: s.confidence,
        evidence_count: s.evidence_count,
        observed_days: s.observed_days,
        emitted_at: s.emitted_at,
        body_sha256: s.body_sha256,
      });
    }
  });
  tx();
  closeDb(w);
  _resetWriterRegistry();
  // impl-008 RED #4 cross-cut: skills_for now requires a ready.json marker.
  writeReady(path.dirname(dbPath), {
    schema_version: 2,
    lodestone_version: "0.1.1",
    ready: true,
    embedder: { id: "nomic-text-v1.5", dim: 768, quant: "fp32" },
    languages_indexed: ["typescript"],
    indexed_at: "2026-05-02T00:00:00Z",
    commit_at_index: null,
    dirty_at_index: false,
    index_epoch: 1,
    writer_pid: process.pid,
  });
}

const NOW = "2026-05-01T00:00:00.000Z";

const SEED_ERROR_SKILL: SeedSkill = {
  id: "seed-error-subclass",
  slug: "custom-error-subclass",
  name: "Custom Error Subclass Pattern",
  description: "Project errors extend a base AppError class with a code field.",
  body: "# Custom Error Subclass Pattern\n\nAlways extend AppError…",
  source_cluster_id: null,
  maturity: "deterministic_seed",
  confidence: 0.95,
  evidence_count: 12,
  observed_days: 0,
  emitted_at: NOW,
  body_sha256: "deadbeef".repeat(8),
};

const EMERGING_AUTH_SKILL: SeedSkill = {
  id: "emerging-auth-handler",
  slug: "auth-handler-style",
  name: "Auth Handler Pattern",
  description: "Auth routes wrap handlers in withSession() before delegating.",
  body: "# Auth Handler Pattern\n\nWrap with withSession…",
  // Set NULL — these tests don't seed a clusters row, so a non-NULL
  // source_cluster_id would trip the FK constraint.
  source_cluster_id: null,
  maturity: "emerging",
  confidence: 0.6,
  evidence_count: 4,
  observed_days: 9,
  emitted_at: NOW,
  body_sha256: "feedface".repeat(8),
};

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "lodestone-skills-"));
  const lodestoneDir = path.join(tmp, ".lodestone");
  mkdirSync(lodestoneDir, { recursive: true });
  dbPath = path.join(lodestoneDir, "lodestone.sqlite");
});

afterEach(() => {
  _resetWriterRegistry();
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

const ctx = () => ({ openReader: () => openReader(dbPath) });

describe("skills_for MCP tool — description gate", () => {
  it("description is >=150 chars", () => {
    expect(SKILLS_FOR_DESCRIPTION.length).toBeGreaterThanOrEqual(150);
  });

  it("description mentions skill, maturity, codebase keywords", () => {
    const d = SKILLS_FOR_DESCRIPTION.toLowerCase();
    for (const kw of ["skill", "maturity", "codebase", "pattern"]) {
      expect(d).toContain(kw);
    }
  });

  it("description carries the §16 honesty mandate (best after >=7 days, seed for fresh install, may return zero, no hallucination)", () => {
    // Codex impl-016 YELLOW: the honesty caveat lived only in MCP-TOOLS.md;
    // Claude Code reads tools/list at selection time, not the docs site.
    const d = SKILLS_FOR_DESCRIPTION.toLowerCase();
    expect(d).toContain("7 days");
    expect(d).toContain("seed");
    expect(d).toContain("fresh install");
    // honest-empty + no-hallucination framing
    expect(d).toMatch(/zero|empty|no result/);
    expect(d).toContain("does not hallucinate");
  });

  it("input schema accepts a task_description and top_k", () => {
    const parsed = inputSchema.parse({ task_description: "add error handling", top_k: 3 });
    expect(parsed.task_description).toBe("add error handling");
    expect(parsed.top_k).toBe(3);
  });
});

describe("skills_for MCP tool — empty + matching", () => {
  it("returns empty list (not error) when no skills emitted yet", async () => {
    seedFixture(dbPath, []);
    const handler = createSkillsForHandler(ctx());
    const env = await handler({ task_description: "anything" });
    expect(env.results).toEqual([]);
    expect(env.channel).toBe("code");
    expect((env.diagnostics.warnings ?? []).length).toBeGreaterThan(0);
  });

  it("returns matching seed skill via substring fallback (no embeddings)", async () => {
    seedFixture(dbPath, [SEED_ERROR_SKILL]);
    const handler = createSkillsForHandler(ctx());
    const env = await handler({
      task_description: "how do I add error handling in this codebase",
    });
    expect(env.results).toHaveLength(1);
    expect(env.results[0]!.slug).toBe("custom-error-subclass");
    expect(env.results[0]!.maturity).toBe("deterministic_seed");
  });

  it("each Skill includes body and emitted_at", async () => {
    seedFixture(dbPath, [SEED_ERROR_SKILL]);
    const handler = createSkillsForHandler(ctx());
    const env = await handler({ task_description: "error handling pattern" });
    const s = env.results[0]!;
    expect(typeof s.body).toBe("string");
    expect(s.body).toContain("Custom Error Subclass Pattern");
    expect(s.emitted_at).toBe(NOW);
    expect(typeof s.match_score).toBe("number");
    expect(s.match_score!).toBeGreaterThan(0);
    expect(s.match_score!).toBeLessThanOrEqual(1);
  });
});

describe("skills_for MCP tool — maturity diagnostic (POST-CODEX-001 amendment 3)", () => {
  it("warns when ALL returned skills are deterministic_seed", async () => {
    seedFixture(dbPath, [SEED_ERROR_SKILL]);
    const handler = createSkillsForHandler(ctx());
    const env = await handler({ task_description: "error handling pattern" });
    const warnings = env.diagnostics.warnings ?? [];
    expect(
      warnings.some((w) => w.includes("deterministic_seed")),
    ).toBe(true);
  });

  it("does NOT warn when any non-deterministic_seed skill is in results", async () => {
    seedFixture(dbPath, [SEED_ERROR_SKILL, EMERGING_AUTH_SKILL]);
    const handler = createSkillsForHandler(ctx());
    const env = await handler({ task_description: "auth handler session pattern" });
    const warnings = env.diagnostics.warnings ?? [];
    // Filter out the substring-fallback diagnostic — we only care about the
    // maturity warning here.
    const maturityWarn = warnings.filter((w) => w.includes("deterministic_seed"));
    expect(maturityWarn).toHaveLength(0);
  });
});

describe("skills_for MCP tool — top_k clamping (POST-CODEX-001 amendment 4)", () => {
  it("default top_k is 5 when not supplied", async () => {
    // Seed 7 matchable skills so a default cap is observable.
    const many: SeedSkill[] = Array.from({ length: 7 }, (_, i) => ({
      ...SEED_ERROR_SKILL,
      id: `seed-${i}`,
      slug: `seed-${i}`,
      name: `Seed ${i} error`,
      description: "error handling in some way",
      body: `body ${i}`,
      body_sha256: `hash-${i}`.padEnd(64, "0"),
    }));
    seedFixture(dbPath, many);
    const handler = createSkillsForHandler(ctx());
    const env = await handler({ task_description: "error handling" });
    expect(env.results.length).toBeLessThanOrEqual(5);
  });

  it("top_k > 20 silently clamps to 20 with diagnostics.clamped=true", async () => {
    const many: SeedSkill[] = Array.from({ length: 25 }, (_, i) => ({
      ...SEED_ERROR_SKILL,
      id: `seed-${i}`,
      slug: `seed-${i}`,
      name: `Seed ${i} error`,
      description: "error handling thing",
      body: `body ${i}`,
      body_sha256: `hash-${i}`.padEnd(64, "0"),
    }));
    seedFixture(dbPath, many);
    const handler = createSkillsForHandler(ctx());
    const env = await handler({ task_description: "error handling", top_k: 50 });
    expect(env.results.length).toBeLessThanOrEqual(20);
    expect(env.diagnostics.clamped).toBe(true);
    expect(
      (env.diagnostics.warnings ?? []).some((w) => w.includes("clamped")),
    ).toBe(true);
  });

  it("top_k <= 20 is honored", async () => {
    seedFixture(dbPath, [SEED_ERROR_SKILL, EMERGING_AUTH_SKILL]);
    const handler = createSkillsForHandler(ctx());
    const env = await handler({ task_description: "pattern", top_k: 1 });
    expect(env.results).toHaveLength(1);
    expect(env.diagnostics.clamped).toBeUndefined();
  });
});

describe("skills_for MCP tool — embedding cosine path", () => {
  it("ranks by cosine similarity when embeddings are present", async () => {
    seedFixture(dbPath, [
      { ...SEED_ERROR_SKILL, embedding: [1, 0, 0, 0] },
      { ...EMERGING_AUTH_SKILL, embedding: [0, 1, 0, 0] },
    ]);

    const fakeEmbedder: EmbedderHandle = {
      id: "nomic-text-v1.5",
      dim: 4,
      maxBatch: 1,
      async embed() {
        // Aligned with the auth skill vector → it should rank first.
        return [new Float32Array([0, 1, 0, 0])];
      },
      async dispose() {
        /* no-op */
      },
    };

    const handler = createSkillsForHandler({
      openReader: () => openReader(dbPath),
      loadEmbedder: async () => fakeEmbedder,
    });

    const env = await handler({ task_description: "anything" });
    expect(env.results.length).toBeGreaterThanOrEqual(2);
    expect(env.results[0]!.slug).toBe("auth-handler-style");
    // Cosine match → mapped to [0, 1].
    expect(env.results[0]!.match_score!).toBeGreaterThan(env.results[1]!.match_score!);
  });

  it("falls back to substring scoring if embedder load fails", async () => {
    seedFixture(dbPath, [
      { ...SEED_ERROR_SKILL, embedding: [1, 0, 0, 0] },
    ]);
    const handler = createSkillsForHandler({
      openReader: () => openReader(dbPath),
      loadEmbedder: async () => {
        throw new Error("model weights missing");
      },
    });
    const env = await handler({ task_description: "error handling" });
    expect(env.results).toHaveLength(1);
    expect(
      (env.diagnostics.warnings ?? []).some((w) => w.includes("model weights missing")),
    ).toBe(true);
  });
});

describe("skills_for MCP tool — mixed embedding populations (impl-016 YELLOW)", () => {
  it("merges unembedded skill rows via substring fallback when corpus is mixed", async () => {
    // Seed two skills: one embedded (auth) and one not (error). Use an
    // embedder vector aligned with auth so cosine ranks auth highest.
    // The error skill MUST still surface for an "error" query — without
    // the merge, the unembedded row is silently dropped.
    seedFixture(dbPath, [
      { ...EMERGING_AUTH_SKILL, embedding: [0, 1, 0, 0] },
      // No embedding on this one — pre-embed era / partial reindex.
      SEED_ERROR_SKILL,
    ]);

    const fakeEmbedder: EmbedderHandle = {
      id: "nomic-text-v1.5",
      dim: 4,
      maxBatch: 1,
      async embed() {
        // Aligned with the auth embedding vector.
        return [new Float32Array([0, 1, 0, 0])];
      },
      async dispose() {
        /* no-op */
      },
    };

    const handler = createSkillsForHandler({
      openReader: () => openReader(dbPath),
      loadEmbedder: async () => fakeEmbedder,
    });

    const env = await handler({ task_description: "error handling pattern" });
    const slugs = env.results.map((s) => s.slug);
    // BOTH must appear: the embedded auth via cosine, the unembedded
    // error via lexical fallback. Pre-fix behavior dropped the latter.
    expect(slugs).toContain("auth-handler-style");
    expect(slugs).toContain("custom-error-subclass");
    const warnings = env.diagnostics.warnings ?? [];
    expect(warnings.some((w) => w.toLowerCase().includes("mixed"))).toBe(true);
  });
});

describe("skills_for MCP tool — disk-truth body (impl-016 YELLOW)", () => {
  it("returns the on-disk SKILL.md body when the file exists, not the SQLite snapshot", async () => {
    // The §10 emitter writes SKILL.md to <lodestoneDir>/skills/<source>/<slug>/SKILL.md
    // where source is seed|emerging|observed (per emit.ts EmitSource). The
    // DB row stores a snapshot of the body for indexing, but disk is truth
    // — friends edit cards in place.
    const stale = "# STALE — do not return this\n\nThis is the SQLite snapshot, never the right answer.";
    const fresh = "# Custom Error Subclass Pattern\n\nFRESH on-disk content the friend hand-edited.";

    seedFixture(dbPath, [{ ...SEED_ERROR_SKILL, body: stale }]);

    // Mirror what the §10 emitter would have written. Maturity
    // deterministic_seed lands under "seed/" (frontmatter.ts:101).
    const lodestoneDir = path.dirname(dbPath);
    const skillDir = path.join(lodestoneDir, "skills", "seed", SEED_ERROR_SKILL.slug);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, "SKILL.md"), fresh);

    const handler = createSkillsForHandler(ctx());
    const env = await handler({ task_description: "error handling pattern" });
    expect(env.results).toHaveLength(1);
    expect(env.results[0]!.body).toContain("FRESH on-disk");
    expect(env.results[0]!.body).not.toContain("STALE");
  });

  it("falls back to the SQLite body when the on-disk SKILL.md is absent", async () => {
    // No disk file present — the DB body is the only source. Must still
    // return content (not throw, not strip body).
    seedFixture(dbPath, [SEED_ERROR_SKILL]);
    const handler = createSkillsForHandler(ctx());
    const env = await handler({ task_description: "error handling pattern" });
    expect(env.results).toHaveLength(1);
    expect(env.results[0]!.body).toBe(SEED_ERROR_SKILL.body);
  });

  it("rejects path-traversal slugs by falling back to the DB body", async () => {
    // A pathological slug that would escape the skills dir if naively
    // joined. Even if such a row somehow lands in SQLite (the §10 emitter
    // slugifies, but defense-in-depth: the read-side must NOT happily
    // resolve a slug containing `..` to a path outside .lodestone/skills).
    const evilSlug = "../../etc/skill";
    seedFixture(dbPath, [{ ...SEED_ERROR_SKILL, slug: evilSlug }]);
    const handler = createSkillsForHandler(ctx());
    const env = await handler({ task_description: "error handling pattern" });
    expect(env.results).toHaveLength(1);
    // Must use DB body — never resolve the traversed path.
    expect(env.results[0]!.body).toBe(SEED_ERROR_SKILL.body);
  });

  it("respects emerging/observed source dirs (not just seed)", async () => {
    const fresh = "# Auth Handler Pattern\n\nFRESH emerging-source disk content.";
    seedFixture(dbPath, [{ ...EMERGING_AUTH_SKILL, body: "stale db" }]);

    const lodestoneDir = path.dirname(dbPath);
    const skillDir = path.join(lodestoneDir, "skills", "emerging", EMERGING_AUTH_SKILL.slug);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, "SKILL.md"), fresh);

    const handler = createSkillsForHandler(ctx());
    const env = await handler({ task_description: "auth handler session pattern" });
    expect(env.results[0]!.body).toContain("FRESH emerging-source");
  });
});

describe("skills_for MCP tool — error paths", () => {
  it("converts schema validation failures into an error envelope", async () => {
    seedFixture(dbPath, [SEED_ERROR_SKILL]);
    const handler = createSkillsForHandler(ctx());
    const env = await handler({} as unknown);
    expect(env.results).toEqual([]);
    expect(env.channel).toBe("code");
  });

  it("converts reader-open failures into an error envelope", async () => {
    const handler = createSkillsForHandler({
      openReader: () => {
        throw new Error("boom: not found");
      },
    });
    const env = await handler({ task_description: "anything" });
    expect(env.results).toEqual([]);
    expect((env.diagnostics.warnings ?? []).some((w) => w.includes("boom"))).toBe(true);
  });
});

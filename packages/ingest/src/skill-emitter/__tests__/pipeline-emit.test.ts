// SPDX-License-Identifier: Apache-2.0
// Tests for the §10 YELLOW pipeline-emit helpers.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";

import { emitClusterSkills, emitSeedSkillFiles } from "../pipeline-emit.js";
import { mkCluster } from "./fixtures.js";
import type { Skill } from "@lodestone/shared";

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "lodestone-pipeline-emit-"));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

const SCHEMA_DDL = [
  `CREATE TABLE clusters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_status TEXT NOT NULL,
      description TEXT,
      description_embedding BLOB,
      size INTEGER NOT NULL,
      algorithm TEXT NOT NULL,
      algorithm_version TEXT NOT NULL,
      modularity REAL,
      index_epoch INTEGER NOT NULL
    )`,
  `CREATE TABLE skills (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      description_embedding BLOB,
      body TEXT NOT NULL,
      source_cluster_id TEXT REFERENCES clusters(id) ON DELETE SET NULL,
      maturity TEXT NOT NULL,
      confidence REAL NOT NULL,
      evidence_count INTEGER NOT NULL,
      observed_days INTEGER NOT NULL,
      emitted_at TEXT NOT NULL,
      expires_at TEXT,
      body_sha256 TEXT NOT NULL
    )`,
];

/**
 * Build an in-memory SQLite DB with the minimum schema needed by emit() —
 * `clusters` and `skills`. Avoids the full bootstrap path so this test stays
 * decoupled from store-migration drift in parallel agent work.
 */
function makeDb(): Database.Database {
  const db = new Database(":memory:");
  for (const ddl of SCHEMA_DDL) db.prepare(ddl).run();
  db.pragma("foreign_keys = ON");
  return db;
}

function insertClusterStub(db: Database.Database, id: string, name: string): void {
  db.prepare(
    `INSERT INTO clusters (
       id, name, name_status, description, description_embedding,
       size, algorithm, algorithm_version, modularity, index_epoch
     ) VALUES (?, ?, 'heuristic', 'stub', NULL, 5, 'louvain', 'louvain@0.0', 0.5, 1)`,
  ).run(id, name);
}

describe("emitClusterSkills (§10 YELLOW pipeline wiring)", () => {
  it("writes a SKILL.md per cluster that passes selection", async () => {
    const db = makeDb();
    try {
      const c1 = mkCluster({ id: "cluster-aaaa", name: "Auth", size: 5 });
      const c2 = mkCluster({ id: "cluster-bbbb", name: "Storage", size: 4 });
      insertClusterStub(db, c1.id, c1.name);
      insertClusterStub(db, c2.id, c2.name);

      const result = await emitClusterSkills([c1, c2], {
        lodestoneDir: join(workdir, ".lodestone"),
        db,
        now: new Date("2026-05-01T00:00:00Z"),
      });

      expect(result.written).toBe(2);
      expect(result.unchanged).toBe(0);
      expect(result.rejected).toBe(0);
      expect(existsSync(join(workdir, ".lodestone/skills/emerging/auth/SKILL.md"))).toBe(true);
      expect(existsSync(join(workdir, ".lodestone/skills/emerging/storage/SKILL.md"))).toBe(true);
    } finally {
      db.close();
    }
  });

  it("rejects clusters that fail selection (size < minSize)", async () => {
    const db = makeDb();
    try {
      const tiny = mkCluster({ id: "cluster-tiny", name: "Tiny", size: 1 });
      const big = mkCluster({ id: "cluster-big", name: "Big", size: 5 });
      insertClusterStub(db, tiny.id, tiny.name);
      insertClusterStub(db, big.id, big.name);

      const result = await emitClusterSkills([tiny, big], {
        lodestoneDir: join(workdir, ".lodestone"),
        db,
        now: new Date("2026-05-01T00:00:00Z"),
      });

      expect(result.written).toBe(1);
      expect(result.rejected).toBe(1);
      expect(existsSync(join(workdir, ".lodestone/skills/emerging/tiny/SKILL.md"))).toBe(false);
      expect(existsSync(join(workdir, ".lodestone/skills/emerging/big/SKILL.md"))).toBe(true);
    } finally {
      db.close();
    }
  });

  it("is idempotent across re-runs (unchanged on second pass)", async () => {
    const db = makeDb();
    try {
      const c = mkCluster({ id: "cluster-rerun", name: "Rerun", size: 5 });
      insertClusterStub(db, c.id, c.name);

      const a = await emitClusterSkills([c], {
        lodestoneDir: join(workdir, ".lodestone"),
        db,
        now: new Date("2026-05-01T00:00:00Z"),
      });
      const b = await emitClusterSkills([c], {
        lodestoneDir: join(workdir, ".lodestone"),
        db,
        now: new Date("2026-05-01T00:00:00Z"),
      });

      expect(a.written).toBe(1);
      expect(b.written).toBe(0);
      expect(b.unchanged).toBe(1);
    } finally {
      db.close();
    }
  });

  it("does not abort the pipeline on a single-cluster failure", async () => {
    const db = makeDb();
    try {
      // First cluster has no clusters row → FK insert into skills will fail.
      const broken = mkCluster({ id: "missing-fk", name: "Broken", size: 5 });
      const ok = mkCluster({ id: "cluster-ok", name: "OK", size: 5 });
      insertClusterStub(db, ok.id, ok.name);

      const result = await emitClusterSkills([broken, ok], {
        lodestoneDir: join(workdir, ".lodestone"),
        db,
        now: new Date("2026-05-01T00:00:00Z"),
      });

      // The OK cluster still wrote; the broken one is captured in outcomes.
      expect(result.written + result.rejected).toBe(2);
      const okOutcome = result.outcomes.find((o) => o.clusterId === "cluster-ok")!;
      expect(okOutcome.result.written).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe("emitSeedSkillFiles (§11 YELLOW seed disk emission)", () => {
  function makeSeed(slug: string, body: string): Skill {
    return {
      id: `seed-${slug}`,
      slug,
      name: `Seed ${slug}`,
      description: `Seed skill for ${slug}`,
      body,
      source_cluster_id: undefined,
      maturity: "deterministic_seed",
      confidence: 1.0,
      evidence_count: 3,
      observed_days: 0,
      emitted_at: "2026-05-01T00:00:00.000Z",
    };
  }

  it("writes SKILL.md per seed skill into the seed/ subdir", async () => {
    const lodestoneDir = join(workdir, ".lodestone");
    const skills = [
      makeSeed("errors", "# errors\n\nbody A\n"),
      makeSeed("framework-express", "# express\n\nbody B\n"),
    ];

    const result = await emitSeedSkillFiles(skills, lodestoneDir);
    expect(result.written).toBe(2);
    expect(existsSync(join(lodestoneDir, "skills/seed/errors/SKILL.md"))).toBe(true);
    expect(existsSync(join(lodestoneDir, "skills/seed/framework-express/SKILL.md"))).toBe(true);
  });

  it("frontmatter source field is 'seed'", async () => {
    const lodestoneDir = join(workdir, ".lodestone");
    const skills = [makeSeed("errors", "# errors\n\nseed body\n")];
    await emitSeedSkillFiles(skills, lodestoneDir);
    const text = readFileSync(join(lodestoneDir, "skills/seed/errors/SKILL.md"), "utf8");
    expect(text).toMatch(/^---\n/);
    expect(text).toMatch(/source: seed\n/);
    expect(text).toMatch(/# errors/);
  });

  it("is idempotent — same body, no rewrite", async () => {
    const lodestoneDir = join(workdir, ".lodestone");
    const skills = [makeSeed("errors", "# errors\n\nstable body\n")];

    const a = await emitSeedSkillFiles(skills, lodestoneDir);
    const b = await emitSeedSkillFiles(skills, lodestoneDir);
    expect(a.written).toBe(1);
    expect(b.written).toBe(0);
    expect(b.unchanged).toBe(1);
  });

  it("rewrites when body changes", async () => {
    const lodestoneDir = join(workdir, ".lodestone");
    await emitSeedSkillFiles([makeSeed("errors", "# v1\n\nbody1\n")], lodestoneDir);
    const r2 = await emitSeedSkillFiles([makeSeed("errors", "# v2\n\nbody2\n")], lodestoneDir);
    expect(r2.written).toBe(1);
    const text = readFileSync(join(lodestoneDir, "skills/seed/errors/SKILL.md"), "utf8");
    expect(text).toContain("# v2");
  });
});

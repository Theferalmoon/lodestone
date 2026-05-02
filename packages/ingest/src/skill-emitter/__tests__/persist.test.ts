// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Skill } from "@lodestone/shared";

import { _resetWriterRegistry, bootstrap, closeDb, openWriter } from "../../store/sqlite.js";

import { writeSkill, writeSkills } from "../persist.js";

let workdir: string;
let dbPath: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "lodestone-skill-persist-"));
  dbPath = join(workdir, "lodestone.sqlite");
});

afterEach(() => {
  _resetWriterRegistry();
  rmSync(workdir, { recursive: true, force: true });
});

function mkSkill(over: Partial<Skill> = {}): Skill {
  return {
    id: over.id ?? "skill-1",
    slug: over.slug ?? "auth-pipeline",
    name: over.name ?? "Auth pipeline",
    description: over.description ?? "Login + token issuance.",
    body: over.body ?? "# Auth pipeline\n\nbody\n",
    // No clusters table row exists in this isolated unit test — leave the FK
    // pointer unset so we exercise the deterministic_seed-style code path.
    source_cluster_id: over.source_cluster_id,
    maturity: over.maturity ?? "emerging",
    confidence: over.confidence ?? 0.65,
    evidence_count: over.evidence_count ?? 5,
    observed_days: over.observed_days ?? 7,
    emitted_at: over.emitted_at ?? "2026-05-01T00:00:00.000Z",
  };
}

describe("writeSkill", () => {
  it("inserts a new row", () => {
    const db = openWriter(dbPath);
    bootstrap(db);
    try {
      const result = writeSkill(db, mkSkill(), { body_sha256: "abc" });
      expect(result).toBe("inserted");
      const row = db.prepare("SELECT slug, maturity FROM skills WHERE id = ?").get("skill-1");
      expect(row).toEqual({ slug: "auth-pipeline", maturity: "emerging" });
    } finally {
      closeDb(db);
    }
  });

  it("returns 'unchanged' when body_sha256 matches the existing row", () => {
    const db = openWriter(dbPath);
    bootstrap(db);
    try {
      writeSkill(db, mkSkill(), { body_sha256: "sha-v1" });
      const second = writeSkill(db, mkSkill(), { body_sha256: "sha-v1" });
      expect(second).toBe("unchanged");
    } finally {
      closeDb(db);
    }
  });

  it("updates when body_sha256 changes", () => {
    const db = openWriter(dbPath);
    bootstrap(db);
    try {
      writeSkill(db, mkSkill({ confidence: 0.5 }), { body_sha256: "sha-v1" });
      const second = writeSkill(db, mkSkill({ confidence: 0.9 }), { body_sha256: "sha-v2" });
      expect(second).toBe("updated");
      const row = db
        .prepare("SELECT confidence, body_sha256 FROM skills WHERE id = ?")
        .get("skill-1") as { confidence: number; body_sha256: string };
      expect(row.confidence).toBeCloseTo(0.9);
      expect(row.body_sha256).toBe("sha-v2");
    } finally {
      closeDb(db);
    }
  });
});

describe("writeSkills", () => {
  it("returns counts of written vs unchanged", () => {
    const db = openWriter(dbPath);
    bootstrap(db);
    try {
      const r1 = writeSkills(db, [
        { skill: mkSkill({ id: "a", slug: "slug-a" }), body_sha256: "sha-a" },
        { skill: mkSkill({ id: "b", slug: "slug-b" }), body_sha256: "sha-b" },
      ]);
      expect(r1).toEqual({ written: 2, unchanged: 0 });

      const r2 = writeSkills(db, [
        { skill: mkSkill({ id: "a", slug: "slug-a" }), body_sha256: "sha-a" }, // unchanged
        {
          skill: mkSkill({ id: "b", slug: "slug-b", confidence: 0.99 }),
          body_sha256: "sha-b-v2",
        }, // updated
      ]);
      expect(r2).toEqual({ written: 1, unchanged: 1 });
    } finally {
      closeDb(db);
    }
  });
});

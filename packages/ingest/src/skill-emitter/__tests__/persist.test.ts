// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Skill } from "@lodestone/shared";

import type { EmbedderHandle } from "../../embed/runtime.js";
import { _resetWriterRegistry, bootstrap, closeDb, openWriter } from "../../store/sqlite.js";

import { writeSkill, writeSkills } from "../persist.js";

const VECTOR_DIM = 768;

/** Tiny deterministic embedder for the backfill test. */
function mkEmbedder(): EmbedderHandle {
  const sample = (text: string): Float32Array => {
    let state = 0;
    for (let i = 0; i < text.length; i++) {
      state = (state * 31 + text.charCodeAt(i)) >>> 0;
    }
    const out = new Float32Array(VECTOR_DIM);
    out[0] = (state % 1_000) / 1_000;
    out[1] = 1 - out[0]!;
    let norm = 0;
    for (let i = 0; i < VECTOR_DIM; i++) norm += (out[i] ?? 0) * (out[i] ?? 0);
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < VECTOR_DIM; i++) out[i] = (out[i] ?? 0) / norm;
    return out;
  };
  return {
    id: "test-deterministic",
    dim: VECTOR_DIM,
    maxBatch: 64,
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map((t) => sample(t));
    },
    async dispose(): Promise<void> {
      /* no-op */
    },
  };
}

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
  it("returns counts of written vs unchanged", async () => {
    const db = openWriter(dbPath);
    bootstrap(db);
    try {
      const r1 = await writeSkills(db, [
        { skill: mkSkill({ id: "a", slug: "slug-a" }), body_sha256: "sha-a" },
        { skill: mkSkill({ id: "b", slug: "slug-b" }), body_sha256: "sha-b" },
      ]);
      expect(r1).toEqual({ written: 2, unchanged: 0 });

      const r2 = await writeSkills(db, [
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

  it("leaves description_embedding NULL when no embedder is supplied", async () => {
    const db = openWriter(dbPath);
    bootstrap(db);
    try {
      await writeSkills(db, [
        { skill: mkSkill({ id: "no-emb" }), body_sha256: "sha-no-emb" },
      ]);
      const row = db
        .prepare(
          "SELECT description_embedding FROM skills WHERE id = 'no-emb'",
        )
        .get() as { description_embedding: Buffer | null };
      expect(row.description_embedding).toBeNull();
    } finally {
      closeDb(db);
    }
  });

  it("backfills description_embedding (BLOB) when an embedder is supplied", async () => {
    const db = openWriter(dbPath);
    bootstrap(db);
    try {
      await writeSkills(
        db,
        [
          {
            skill: mkSkill({ id: "with-emb", description: "auth login flow" }),
            body_sha256: "sha-with-emb",
          },
        ],
        { embedder: mkEmbedder() },
      );
      const row = db
        .prepare(
          "SELECT description_embedding FROM skills WHERE id = 'with-emb'",
        )
        .get() as { description_embedding: Buffer | null };
      expect(row.description_embedding).not.toBeNull();
      expect(Buffer.isBuffer(row.description_embedding)).toBe(true);
      expect(row.description_embedding!.byteLength).toBe(VECTOR_DIM * 4);
    } finally {
      closeDb(db);
    }
  });
});

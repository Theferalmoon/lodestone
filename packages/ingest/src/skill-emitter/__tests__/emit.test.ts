// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type Database from "better-sqlite3";

import { _resetWriterRegistry, bootstrap, closeDb, openWriter } from "../../store/sqlite.js";

import { emit } from "../emit.js";
import { parseFrontmatter } from "../frontmatter.js";
import { mkCluster } from "./fixtures.js";

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "lodestone-emit-test-"));
});

afterEach(() => {
  _resetWriterRegistry();
  rmSync(workdir, { recursive: true, force: true });
});

function insertClusterStub(db: Database.Database, id: string, name: string): void {
  db.prepare(
    `INSERT INTO clusters (
       id, name, name_status, description, description_embedding,
       size, algorithm, algorithm_version, modularity, index_epoch
     ) VALUES (?, ?, 'heuristic', 'stub', NULL, 1, 'louvain', 'louvain@0.0', 0.5, 1)`,
  ).run(id, name);
}

describe("emit", () => {
  it("writes .lodestone/skills/emerging/<slug>/SKILL.md with valid YAML frontmatter", async () => {
    const cluster = mkCluster({ id: "abcd", name: "Auth pipeline", size: 5 });
    const result = await emit(cluster, {
      lodestoneDir: join(workdir, ".lodestone"),
      createdAt: "2026-04-25T00:00:00Z",
      now: new Date("2026-05-01T00:00:00Z"),
      id: "fixed-id",
    });
    expect(result.written).toBe(true);
    if (!result.written) throw new Error("expected written");
    expect(result.path).toMatch(/\.lodestone\/skills\/emerging\/auth-pipeline\/SKILL\.md$/);

    const text = readFileSync(result.path, "utf8");
    const parsed = parseFrontmatter(text);
    expect(parsed).not.toBeNull();
    expect(parsed!.fields.id).toBe("fixed-id");
    expect(parsed!.fields.slug).toBe("auth-pipeline");
    expect(parsed!.fields.source).toBe("emerging");
    expect(parsed!.fields.member_count).toBe(5);
    expect(parsed!.fields.observed_days).toBe(6);
    expect(parsed!.fields.content_sha256).toBe(result.sha256);
  });

  it("is idempotent: same cluster, same body — no rewrite, mtime unchanged", async () => {
    const cluster = mkCluster({ id: "abcd", size: 5 });
    const cfg = {
      lodestoneDir: join(workdir, ".lodestone"),
      createdAt: "2026-04-25T00:00:00Z",
      now: new Date("2026-05-01T00:00:00Z"),
      id: "fixed-id",
    };
    const first = await emit(cluster, cfg);
    if (!first.written) throw new Error("first emit must write");
    const mtime1 = statSync(first.path).mtimeMs;

    // Sleep 10ms so mtime would tick if we wrote again.
    await new Promise((r) => setTimeout(r, 10));

    const second = await emit(cluster, cfg);
    expect(second.written).toBe(false);
    if (second.written) throw new Error("unreachable");
    expect(second.reason).toBe("unchanged");
    const mtime2 = statSync(first.path).mtimeMs;
    expect(mtime2).toBe(mtime1);
  });

  it("rewrites when the body changes (different cluster description)", async () => {
    const cfg = {
      lodestoneDir: join(workdir, ".lodestone"),
      createdAt: "2026-04-25T00:00:00Z",
      now: new Date("2026-05-01T00:00:00Z"),
      id: "fixed-id",
    };
    const first = await emit(mkCluster({ id: "abcd", description: "v1 desc" }), cfg);
    if (!first.written) throw new Error("first emit must write");
    const second = await emit(mkCluster({ id: "abcd", description: "v2 desc" }), cfg);
    expect(second.written).toBe(true);
  });

  it("returns selection_rejected when shouldEmit fails", async () => {
    const cluster = mkCluster({ id: "abcd", size: 1 });
    const result = await emit(cluster, {
      lodestoneDir: join(workdir, ".lodestone"),
      createdAt: "2026-04-25T00:00:00Z",
      now: new Date("2026-05-01T00:00:00Z"),
    });
    expect(result.written).toBe(false);
    if (result.written) throw new Error("unreachable");
    expect(result.reason).toBe("selection_rejected");
    expect(result.decision_reason).toBe("too_small");
  });

  it("labels the source as 'observed' when observed_days >= 30", async () => {
    const cluster = mkCluster({ id: "abcd", size: 5 });
    const result = await emit(cluster, {
      lodestoneDir: join(workdir, ".lodestone"),
      createdAt: "2026-03-01T00:00:00Z",
      now: new Date("2026-05-01T00:00:00Z"),
    });
    expect(result.written).toBe(true);
    if (!result.written) throw new Error("unreachable");
    expect(result.path).toMatch(/skills\/observed\//);
  });

  it("mirrors to the SQLite skills table when a db handle is supplied", async () => {
    const dbPath = join(workdir, ".lodestone", "lodestone.sqlite");
    const db = openWriter(dbPath);
    bootstrap(db);
    try {
      const cluster = mkCluster({ id: "abcd1234abcd1234", size: 6 });
      // Skills table FKs source_cluster_id -> clusters(id). Stub a row so the
      // upsert doesn't trip the FK in this isolated unit test.
      insertClusterStub(db, cluster.id, cluster.name);
      const result = await emit(cluster, {
        lodestoneDir: join(workdir, ".lodestone"),
        createdAt: "2026-04-25T00:00:00Z",
        now: new Date("2026-05-01T00:00:00Z"),
        db,
        id: "skill-uuid-1",
      });
      expect(result.written).toBe(true);
      const row = db
        .prepare("SELECT id, slug, maturity, body_sha256 FROM skills WHERE id = ?")
        .get("skill-uuid-1") as
        | { id: string; slug: string; maturity: string; body_sha256: string }
        | undefined;
      expect(row).toBeDefined();
      expect(row!.maturity).toBe("emerging");
      if (!result.written) throw new Error("unreachable");
      expect(row!.body_sha256).toBe(result.sha256);
    } finally {
      closeDb(db);
    }
  });

  it("snapshot: SKILL.md text is byte-stable for the auth fixture", async () => {
    const cluster = mkCluster({
      id: "abcd1234abcd1234",
      name: "Auth pipeline",
      size: 5,
      bridges: 1,
    });
    const result = await emit(cluster, {
      lodestoneDir: join(workdir, ".lodestone"),
      createdAt: "2026-04-25T00:00:00Z",
      now: new Date("2026-05-01T12:00:00Z"),
      id: "fixed-id-snapshot",
    });
    if (!result.written) throw new Error("unreachable");
    const text = readFileSync(result.path, "utf8");
    expect(text).toMatchSnapshot();
  });

  it("recognizes a hand-written SKILL.md with matching SHA as unchanged", async () => {
    // Pre-emit, capture text, blow away mtime, re-emit. Establishes that the
    // SHA check (not file mtime) drives idempotency.
    const cluster = mkCluster({ id: "abcd", size: 4 });
    const cfg = {
      lodestoneDir: join(workdir, ".lodestone"),
      createdAt: "2026-04-25T00:00:00Z",
      now: new Date("2026-05-01T00:00:00Z"),
      id: "stable-id",
    };
    const first = await emit(cluster, cfg);
    if (!first.written) throw new Error("first emit must write");
    const original = readFileSync(first.path, "utf8");
    // Touch with same content (mtime would tick).
    writeFileSync(first.path, original, "utf8");
    const second = await emit(cluster, cfg);
    expect(second.written).toBe(false);
  });

  // Codex v0.1.1 §10 RED #1: id must be stable across content updates without
  // requiring callers to thread cfg.id. A second emit with a CHANGED body must
  // reuse the same id (existing frontmatter id), and absent any prior file the
  // id must be deterministic from cluster identity.
  it("RED #1 — reuses existing frontmatter id when body changes", async () => {
    const cfg = {
      lodestoneDir: join(workdir, ".lodestone"),
      createdAt: "2026-04-25T00:00:00Z",
      now: new Date("2026-05-01T00:00:00Z"),
      // No cfg.id — let the emitter derive it.
    };
    const first = await emit(mkCluster({ id: "abcd", description: "v1" }), cfg);
    if (!first.written) throw new Error("first emit must write");
    const firstId = first.skill.id;

    // Body changes (different description), but id should be stable.
    const second = await emit(mkCluster({ id: "abcd", description: "v2 — different" }), cfg);
    expect(second.written).toBe(true);
    if (!second.written) throw new Error("unreachable");
    expect(second.skill.id).toBe(firstId);
  });

  it("RED #1 — derives a deterministic id from cluster id when no cfg.id and no prior file", async () => {
    const cfg = {
      lodestoneDir: join(workdir, ".lodestone"),
      createdAt: "2026-04-25T00:00:00Z",
      now: new Date("2026-05-01T00:00:00Z"),
    };
    const a = await emit(mkCluster({ id: "abcd1234abcd1234" }), cfg);
    if (!a.written) throw new Error("a must write");

    // Tear down workdir and re-emit fresh — id must match because it's derived
    // from cluster identity, not random.
    rmSync(workdir, { recursive: true, force: true });
    const b = await emit(mkCluster({ id: "abcd1234abcd1234" }), {
      ...cfg,
      lodestoneDir: join(workdir, ".lodestone"),
    });
    if (!b.written) throw new Error("b must write");
    expect(b.skill.id).toBe(a.skill.id);
  });

  it("RED #1 — different cluster ids yield different deterministic ids", async () => {
    const cfg = {
      lodestoneDir: join(workdir, ".lodestone"),
      createdAt: "2026-04-25T00:00:00Z",
      now: new Date("2026-05-01T00:00:00Z"),
    };
    const a = await emit(mkCluster({ id: "cluster-aaaa", name: "Auth A" }), cfg);
    const b = await emit(mkCluster({ id: "cluster-bbbb", name: "Auth B" }), cfg);
    if (!a.written || !b.written) throw new Error("both must write");
    expect(a.skill.id).not.toBe(b.skill.id);
  });

  it("YELLOW — body is byte-stable when upstream member/bridge order shuffles among equal-pagerank entries", async () => {
    const cfg = {
      lodestoneDir: join(workdir, ".lodestone"),
      createdAt: "2026-04-25T00:00:00Z",
      now: new Date("2026-05-01T00:00:00Z"),
      id: "fixed-id",
    };
    // Build two clusters whose members all share identical pagerank — only
    // the order in the input array differs. The rendered body MUST be
    // identical, otherwise downstream churn from upstream sort instability
    // will rewrite SKILL.md unnecessarily.
    const baseCluster = mkCluster({ id: "abcd", size: 5, bridges: 2 });
    const memberPRs = baseCluster.members.map((m) => ({ ...m, pagerank: 0.42 }));
    const orderA = {
      ...baseCluster,
      members: memberPRs,
      bridges: [memberPRs[0]!, memberPRs[1]!],
    };
    const orderB = {
      ...baseCluster,
      members: [...memberPRs].reverse(),
      bridges: [memberPRs[1]!, memberPRs[0]!],
    };
    const a = await emit(orderA, cfg);
    if (!a.written) throw new Error("a must write");
    rmSync(workdir, { recursive: true, force: true });
    const b = await emit(orderB, {
      ...cfg,
      lodestoneDir: join(workdir, ".lodestone"),
    });
    if (!b.written) throw new Error("b must write");
    expect(b.sha256).toBe(a.sha256);
  });

  it("RED #1 — cfg.id (when supplied) takes precedence over derived id", async () => {
    const cfg = {
      lodestoneDir: join(workdir, ".lodestone"),
      createdAt: "2026-04-25T00:00:00Z",
      now: new Date("2026-05-01T00:00:00Z"),
      id: "explicit-override-id",
    };
    const r = await emit(mkCluster({ id: "abcd" }), cfg);
    if (!r.written) throw new Error("must write");
    expect(r.skill.id).toBe("explicit-override-id");
  });
});

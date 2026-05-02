// SPDX-License-Identifier: Apache-2.0
// `cluster` tool — §16 handler tests. Builds a temp SQLite index, seeds a
// known cluster topology, then exercises name-match precedence, semantic
// fallback, granularity caps, the POST-CODEX-001 envelope shape, and the
// empty-result diagnostic.

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  bootstrap,
  closeDb,
  openWriter,
  writeReady,
  _resetWriterRegistry,
} from "@lodestone/ingest/store";
import type { EmbedderHandle } from "@lodestone/ingest/embed";

import { openReader } from "../client/sqlite.js";
import {
  createHandler as createClusterHandler,
  description as CLUSTER_DESCRIPTION,
  inputSchema,
} from "../tools/cluster.js";

/** Seed a deterministic 3-cluster topology into a fresh temp DB. */
function seedFixture(dbPath: string): void {
  const w = openWriter(dbPath);
  bootstrap(w);

  const clusters = [
    {
      id: "cluster-auth",
      name: "auth",
      name_status: "heuristic",
      description: "Authentication and session-token verification.",
      size: 3,
      algorithm: "louvain",
      algorithm_version: "0.1.0",
      modularity: 0.42,
      index_epoch: 1,
    },
    {
      id: "cluster-payments",
      name: "payments",
      name_status: "human",
      description: "Stripe checkout, refund processing, invoice ledger.",
      size: 2,
      algorithm: "louvain",
      algorithm_version: "0.1.0",
      modularity: 0.31,
      index_epoch: 1,
    },
    {
      id: "cluster-ingest",
      name: "ingest",
      name_status: "heuristic",
      description: "Streaming file ingest pipeline with embed and chunk.",
      size: 1,
      algorithm: "louvain",
      algorithm_version: "0.1.0",
      modularity: 0.18,
      index_epoch: 1,
    },
  ];

  const insertCluster = w.prepare(
    `INSERT INTO clusters (id, name, name_status, description, description_embedding,
        size, algorithm, algorithm_version, modularity, index_epoch)
       VALUES (@id, @name, @name_status, @description, NULL,
        @size, @algorithm, @algorithm_version, @modularity, @index_epoch)`,
  );

  const symbols: Array<{
    id: string;
    path: string;
    pagerank: number;
    cluster: string;
  }> = [
    { id: "src/auth/login.ts::login", path: "src/auth/login.ts", pagerank: 0.9, cluster: "cluster-auth" },
    { id: "src/auth/session.ts::verify", path: "src/auth/session.ts", pagerank: 0.5, cluster: "cluster-auth" },
    { id: "src/auth/middleware.ts::guard", path: "src/auth/middleware.ts", pagerank: 0.3, cluster: "cluster-auth" },
    { id: "src/payments/checkout.ts::checkout", path: "src/payments/checkout.ts", pagerank: 0.7, cluster: "cluster-payments" },
    { id: "src/payments/refund.ts::refund", path: "src/payments/refund.ts", pagerank: 0.4, cluster: "cluster-payments" },
    { id: "src/ingest/index.ts::ingest", path: "src/ingest/index.ts", pagerank: 0.6, cluster: "cluster-ingest" },
  ];

  const insertSymbol = w.prepare(
    `INSERT INTO symbols (id, path, language, kind, range_start_line, range_end_line,
        signature, docstring, pagerank, cluster_id, updated_at_commit, updated_at_epoch)
       VALUES (@id, @path, 'typescript', 'function', 1, 10,
        NULL, NULL, @pagerank, @cluster_id, NULL, 1)`,
  );

  const insertMember = w.prepare(
    `INSERT INTO cluster_members (cluster_id, symbol_id, is_bridge)
       VALUES (@cluster_id, @symbol_id, @is_bridge)`,
  );

  const tx = w.transaction(() => {
    for (const c of clusters) insertCluster.run(c);
    for (const s of symbols) {
      insertSymbol.run({ id: s.id, path: s.path, pagerank: s.pagerank, cluster_id: s.cluster });
      insertMember.run({
        cluster_id: s.cluster,
        symbol_id: s.id,
        is_bridge: s.id.endsWith("middleware.ts::guard") ? 1 : 0,
      });
    }
  });
  tx();
  closeDb(w);
  _resetWriterRegistry();
  // impl-008 RED #4 cross-cut: every reader-tool now requires a ready.json
  // marker. Fixture writes one so the cluster handler doesn\'t short-circuit.
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

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "lodestone-cluster-"));
  const lodestoneDir = path.join(tmp, ".lodestone");
  mkdirSync(lodestoneDir, { recursive: true });
  dbPath = path.join(lodestoneDir, "lodestone.sqlite");
  seedFixture(dbPath);
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

describe("cluster MCP tool — description gate", () => {
  it("description is >=150 chars (Claude Code tool-search contract)", () => {
    expect(CLUSTER_DESCRIPTION.length).toBeGreaterThanOrEqual(150);
  });

  it("description mentions architectural-mental-model keywords", () => {
    const d = CLUSTER_DESCRIPTION.toLowerCase();
    for (const kw of [
      "cluster",
      "architectural",
      "louvain",
      "agent_instruction",
      // Codex impl-016 YELLOW: keyword density for Tool Search retrieval.
      "pagerank",
      "bridges",
      "subsystem",
    ]) {
      expect(d).toContain(kw);
    }
  });

  it("input schema accepts a name_or_query and granularity", () => {
    const parsed = inputSchema.parse({ name_or_query: "auth", granularity: "fine" });
    expect(parsed.name_or_query).toBe("auth");
    expect(parsed.granularity).toBe("fine");
  });
});

describe("cluster MCP tool — name-match precedence", () => {
  it("returns the cluster whose name contains the query (case-insensitive)", async () => {
    const handler = createClusterHandler(ctx());
    const env = await handler({ name_or_query: "auth", channel: "code" });
    expect(env.channel).toBe("code");
    expect(env.results).toHaveLength(1);
    expect(env.results[0]!.id).toBe("cluster-auth");
    expect(env.results[0]!.name).toBe("auth");
  });

  it("name match precedence beats semantic — case-insensitive substring wins", async () => {
    const handler = createClusterHandler(ctx());
    const env = await handler({ name_or_query: "AUTH" });
    expect(env.results).toHaveLength(1);
    expect(env.results[0]!.id).toBe("cluster-auth");
  });
});

describe("cluster MCP tool — POST-CODEX-001 envelope shape", () => {
  it("includes name_status, agent_instruction, naming_evidence on every cluster", async () => {
    const handler = createClusterHandler(ctx());
    const env = await handler({ name_or_query: "auth" });
    const cluster = env.results[0]!;
    expect(cluster.name_status).toBe("heuristic");
    // heuristic ⇒ synthesize_name_from_members per amendment.
    expect(cluster.agent_instruction).toBe("synthesize_name_from_members");
    expect(cluster.naming_evidence).toBeDefined();
    expect(cluster.naming_evidence.anchor_symbol).toBe("src/auth/login.ts::login");
    expect(cluster.naming_evidence.members_sampled).toBe(3);
  });

  it("human-confirmed clusters get agent_instruction='use_as_is'", async () => {
    const handler = createClusterHandler(ctx());
    const env = await handler({ name_or_query: "payments" });
    const cluster = env.results[0]!;
    expect(cluster.name_status).toBe("human");
    expect(cluster.agent_instruction).toBe("use_as_is");
  });

  it("includes diagnostics block per §09 amendment", async () => {
    const handler = createClusterHandler(ctx());
    const env = await handler({ name_or_query: "auth" });
    const diag = env.results[0]!.diagnostics;
    expect(diag.algorithm).toBe("louvain");
    expect(diag.algorithm_version).toBe("0.1.0");
    expect(typeof diag.modularity).toBe("number");
    expect(diag.stability_hash).toBe("cluster-auth");
    expect(typeof diag.bridge_count).toBe("number");
  });
});

describe("cluster MCP tool — members and bridges", () => {
  it("members are PageRank-ordered desc", async () => {
    const handler = createClusterHandler(ctx());
    const env = await handler({ name_or_query: "auth" });
    const members = env.results[0]!.members;
    expect(members.map((m) => m.symbol)).toEqual([
      "src/auth/login.ts::login",
      "src/auth/session.ts::verify",
      "src/auth/middleware.ts::guard",
    ]);
    expect(members[0]!.pagerank).toBeGreaterThan(members[2]!.pagerank!);
  });

  it("bridges are sourced from cluster_members.is_bridge=1", async () => {
    const handler = createClusterHandler(ctx());
    const env = await handler({ name_or_query: "auth" });
    const bridges = env.results[0]!.bridges;
    expect(bridges.map((b) => b.symbol)).toEqual([
      "src/auth/middleware.ts::guard",
    ]);
  });

  it("granularity 'fine' caps members at 10", async () => {
    const handler = createClusterHandler(ctx());
    const env = await handler({ name_or_query: "auth", granularity: "fine" });
    expect(env.results[0]!.members.length).toBeLessThanOrEqual(10);
  });
});

describe("cluster MCP tool — semantic fallback", () => {
  it("falls back to substring on description when no name match and no embeddings", async () => {
    const handler = createClusterHandler(ctx());
    // "Stripe" only appears in the payments cluster description.
    const env = await handler({ name_or_query: "Stripe" });
    expect(env.results).toHaveLength(1);
    expect(env.results[0]!.id).toBe("cluster-payments");
    // Diagnostics should mention the substring fallback.
    const warnings = env.diagnostics.warnings ?? [];
    expect(warnings.some((w) => w.includes("substring match"))).toBe(true);
  });

  it("uses cosine similarity when embeddings are present", async () => {
    // Backfill description_embedding with deterministic vectors and supply a
    // mocked embedder so the cosine path is exercised end-to-end.
    const w = openWriter(dbPath);
    const dim = 4;
    const vectors: Record<string, number[]> = {
      "cluster-auth": [1, 0, 0, 0],
      "cluster-payments": [0, 1, 0, 0],
      "cluster-ingest": [0, 0, 1, 0],
    };
    const upd = w.prepare("UPDATE clusters SET description_embedding = ? WHERE id = ?");
    for (const [id, v] of Object.entries(vectors)) {
      const buf = Buffer.alloc(v.length * 4);
      for (let i = 0; i < v.length; i += 1) buf.writeFloatLE(v[i]!, i * 4);
      upd.run(buf, id);
    }
    closeDb(w);
    _resetWriterRegistry();

    const fakeEmbedder: EmbedderHandle = {
      id: "nomic-text-v1.5",
      dim,
      maxBatch: 1,
      async embed() {
        // Closer to ingest than the others.
        return [new Float32Array([0, 0, 1, 0])];
      },
      async dispose() {
        /* no-op */
      },
    };

    const handler = createClusterHandler({
      openReader: () => openReader(dbPath),
      loadEmbedder: async () => fakeEmbedder,
    });

    // Use a phrase that does NOT name-match any cluster.
    const env = await handler({ name_or_query: "stream pipeline question" });
    expect(env.results.length).toBeGreaterThan(0);
    expect(env.results[0]!.id).toBe("cluster-ingest");
  });
});

describe("cluster MCP tool — emitted_skill_id determinism (impl-016 YELLOW)", () => {
  it("picks the most recently emitted skill (then id ASC) when a cluster has multiple", async () => {
    // Seed three skills against cluster-auth with deliberately out-of-order
    // emitted_at timestamps and ids. The handler must pick the newest by
    // emitted_at; ties broken by id ASC. SQLite's natural row order is
    // insert-order, so we insert deliberately mis-ordered to expose any
    // implicit reliance on it.
    const w = openWriter(dbPath);
    const insertSkill = w.prepare(
      `INSERT INTO skills (id, slug, name, description, body, source_cluster_id,
          maturity, confidence, evidence_count, observed_days, emitted_at, body_sha256)
         VALUES (?, ?, ?, ?, ?, ?, 'emerging', 0.7, 5, 9, ?, ?)`,
    );
    insertSkill.run(
      "skill-mid", "auth-mid", "auth mid", "older but inserted first",
      "body", "cluster-auth", "2026-04-29T00:00:00Z", "a".repeat(64),
    );
    insertSkill.run(
      "skill-newest", "auth-new", "auth new", "newest emitted_at",
      "body", "cluster-auth", "2026-05-01T00:00:00Z", "b".repeat(64),
    );
    insertSkill.run(
      "skill-old", "auth-old", "auth old", "oldest",
      "body", "cluster-auth", "2026-04-28T00:00:00Z", "c".repeat(64),
    );
    closeDb(w);
    _resetWriterRegistry();

    const handler = createClusterHandler(ctx());
    const env = await handler({ name_or_query: "auth" });
    expect(env.results[0]!.emitted_skill_id).toBe("skill-newest");
  });

  it("breaks emitted_at ties by id ASC (deterministic across runs)", async () => {
    const w = openWriter(dbPath);
    const insertSkill = w.prepare(
      `INSERT INTO skills (id, slug, name, description, body, source_cluster_id,
          maturity, confidence, evidence_count, observed_days, emitted_at, body_sha256)
         VALUES (?, ?, ?, ?, ?, ?, 'emerging', 0.7, 5, 9, ?, ?)`,
    );
    // Two skills, identical emitted_at — id ASC wins.
    insertSkill.run(
      "skill-zzz", "auth-zzz", "auth zzz", "tied",
      "body", "cluster-auth", "2026-05-01T00:00:00Z", "z".repeat(64),
    );
    insertSkill.run(
      "skill-aaa", "auth-aaa", "auth aaa", "tied",
      "body", "cluster-auth", "2026-05-01T00:00:00Z", "y".repeat(64),
    );
    closeDb(w);
    _resetWriterRegistry();

    const handler = createClusterHandler(ctx());
    const env = await handler({ name_or_query: "auth" });
    expect(env.results[0]!.emitted_skill_id).toBe("skill-aaa");
  });
});

describe("cluster MCP tool — empty + error paths", () => {
  it("returns empty results (not throw) when nothing matches", async () => {
    const handler = createClusterHandler(ctx());
    const env = await handler({ name_or_query: "nonexistent-subsystem-zzzz" });
    expect(env.results).toEqual([]);
    expect(env.channel).toBe("code");
    expect((env.diagnostics.warnings ?? []).length).toBeGreaterThan(0);
  });

  it("converts schema validation failures into an error envelope (no throw)", async () => {
    const handler = createClusterHandler(ctx());
    const env = await handler({} as unknown);
    expect(env.results).toEqual([]);
    expect(env.channel).toBe("code");
  });

  it("converts reader-open failures into an error envelope", async () => {
    const handler = createClusterHandler({
      openReader: () => {
        throw new Error("boom: index not found");
      },
    });
    const env = await handler({ name_or_query: "auth" });
    expect(env.results).toEqual([]);
    expect((env.diagnostics.warnings ?? []).some((w) => w.includes("boom"))).toBe(true);
  });
});

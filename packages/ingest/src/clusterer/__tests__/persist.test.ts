// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Cluster } from "@lodestone/shared";

import type { EmbedderHandle } from "../../embed/runtime.js";
import { bootstrap, openWriter, closeDb } from "../../store/sqlite.js";
import { writeSymbols } from "../../store/writer.js";

import { persistClusters } from "../persist.js";
import { louvainVersion } from "../louvain.js";

const VECTOR_DIM = 768;

/** Tiny deterministic embedder: every text → unit-length Float32Array(768)
 *  whose first lane encodes a stable hash of the text. */
function mkEmbedder(): EmbedderHandle {
  const sample = (text: string): Float32Array => {
    let state = 0;
    for (let i = 0; i < text.length; i++) {
      state = (state * 31 + text.charCodeAt(i)) >>> 0;
    }
    const out = new Float32Array(VECTOR_DIM);
    out[0] = (state % 1_000) / 1_000;
    out[1] = 1 - out[0]!;
    // Normalize so cosine math downstream is sane.
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

function mkCluster(id: string, members: string[]): Cluster {
  return {
    id,
    name: `cluster-${id}`,
    name_status: "heuristic",
    agent_instruction: "synthesize_name_from_members",
    naming_evidence: { anchor_symbol: members[0]!, members_sampled: members.length },
    description: "test",
    size: members.length,
    members: members.map((sym) => ({
      symbol: sym,
      path: "src/x.ts",
      range: { start_line: 1, end_line: 1 },
    })),
    bridges: [],
    diagnostics: {
      algorithm: "louvain",
      algorithm_version: louvainVersion(),
      resolution: 1.5,
      seed: 42,
      graph_node_count: members.length,
      graph_edge_count: 0,
      modularity: 0.5,
      singleton_count: 0,
      bridge_count: 0,
      stability_hash: id,
    },
  };
}

describe("persistClusters", () => {
  let tmp: string;
  let dbPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "lodestone-cluster-persist-"));
    dbPath = path.join(tmp, "test.db");
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("inserts clusters and member rows", async () => {
    const writer = openWriter(dbPath);
    bootstrap(writer);
    writeSymbols(
      writer,
      [
        {
          symbol: "src/x.ts::a",
          path: "src/x.ts",
          range: { start_line: 1, end_line: 1 },
          language: "typescript",
          kind: "function",
        },
        {
          symbol: "src/x.ts::b",
          path: "src/x.ts",
          range: { start_line: 2, end_line: 2 },
          language: "typescript",
          kind: "function",
        },
      ],
      { index_epoch: 1 },
    );
    const clusters = [mkCluster("c1", ["src/x.ts::a", "src/x.ts::b"])];
    const result = await persistClusters(writer, clusters, {
      index_epoch: 1,
      algorithm: "louvain",
      algorithm_version: louvainVersion(),
    });
    expect(result.clustersWritten).toBe(1);
    expect(result.membersWritten).toBe(2);
    const rows = writer.prepare("SELECT id, name FROM clusters").all() as {
      id: string;
      name: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("c1");
    // No embedder supplied → description_embedding stays NULL (backwards-compat).
    const embRow = writer
      .prepare("SELECT description_embedding FROM clusters WHERE id = 'c1'")
      .get() as { description_embedding: Buffer | null };
    expect(embRow.description_embedding).toBeNull();
    closeDb(writer);
  });

  it("backfills description_embedding (BLOB) when an embedder is supplied", async () => {
    const writer = openWriter(dbPath);
    bootstrap(writer);
    writeSymbols(
      writer,
      [
        {
          symbol: "src/x.ts::a",
          path: "src/x.ts",
          range: { start_line: 1, end_line: 1 },
          language: "typescript",
          kind: "function",
        },
      ],
      { index_epoch: 1 },
    );
    const clusters = [mkCluster("c-emb", ["src/x.ts::a"])];
    await persistClusters(writer, clusters, {
      index_epoch: 1,
      algorithm: "louvain",
      algorithm_version: louvainVersion(),
      embedder: mkEmbedder(),
    });
    const row = writer
      .prepare(
        "SELECT description_embedding FROM clusters WHERE id = 'c-emb'",
      )
      .get() as { description_embedding: Buffer | null };
    expect(row.description_embedding).not.toBeNull();
    expect(Buffer.isBuffer(row.description_embedding)).toBe(true);
    expect(row.description_embedding!.byteLength).toBe(VECTOR_DIM * 4);
    closeDb(writer);
  });

  it("is idempotent (same input twice -> same row count, no duplicates)", async () => {
    const writer = openWriter(dbPath);
    bootstrap(writer);
    writeSymbols(
      writer,
      [
        {
          symbol: "src/x.ts::a",
          path: "src/x.ts",
          range: { start_line: 1, end_line: 1 },
          language: "typescript",
          kind: "function",
        },
      ],
      { index_epoch: 1 },
    );
    const clusters = [mkCluster("c1", ["src/x.ts::a"])];
    await persistClusters(writer, clusters, {
      index_epoch: 1,
      algorithm: "louvain",
      algorithm_version: louvainVersion(),
    });
    await persistClusters(writer, clusters, {
      index_epoch: 2,
      algorithm: "louvain",
      algorithm_version: louvainVersion(),
    });
    const clusterCount = writer.prepare("SELECT COUNT(*) as c FROM clusters").get() as {
      c: number;
    };
    expect(clusterCount.c).toBe(1);
    const memberCount = writer
      .prepare("SELECT COUNT(*) as c FROM cluster_members")
      .get() as { c: number };
    expect(memberCount.c).toBe(1);
    closeDb(writer);
  });
});

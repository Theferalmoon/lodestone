// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Cluster } from "@lodestone/shared";

import { bootstrap, openWriter, closeDb } from "../../store/sqlite.js";
import { writeSymbols } from "../../store/writer.js";

import { persistClusters } from "../persist.js";
import { louvainVersion } from "../louvain.js";

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

  it("inserts clusters and member rows", () => {
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
    const result = persistClusters(writer, clusters, {
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
    closeDb(writer);
  });

  it("is idempotent (same input twice -> same row count, no duplicates)", () => {
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
    persistClusters(writer, clusters, {
      index_epoch: 1,
      algorithm: "louvain",
      algorithm_version: louvainVersion(),
    });
    persistClusters(writer, clusters, {
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

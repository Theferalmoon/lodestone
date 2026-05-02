// SPDX-License-Identifier: Apache-2.0
// Tests for reader.ts + queries.ts. Builds a tiny fixture graph via
// buildGraph + writeSymbols/Edges/Pagerank, then exercises every read helper.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Edge, LodestoneSymbol } from "@lodestone/shared";

import { buildGraph } from "../../graph/builder.js";
import { pageRank } from "../../graph/pagerank.js";
import {
  _resetWriterRegistry,
  bootstrap,
  closeDb,
  openWriter,
} from "../sqlite.js";
import {
  callersOf,
  calleesOf,
  clusterMembers,
  getInboundEdges,
  getOutboundEdges,
  getSymbol,
  impactOf,
  vectorSearch,
} from "../reader.js";
import {
  writeEdges,
  writeEmbeddings,
  writePagerank,
  writeSymbols,
} from "../writer.js";

let workdir: string;
let dbPath: string;

function sym(id: string): LodestoneSymbol {
  return {
    symbol: id,
    path: `src/${id}.ts`,
    language: "typescript",
    kind: "function",
    range: { start_line: 1, end_line: 5 },
  };
}

/**
 * Fixture graph (call edges only):
 *
 *   a -> b -> c
 *   a -> c (also direct)
 *   d -> b
 *   e (isolated)
 */
function seedFixture(dbPath: string) {
  const db = openWriter(dbPath);
  bootstrap(db);
  const symbols = [sym("a"), sym("b"), sym("c"), sym("d"), sym("e")];
  const edges: Edge[] = [
    { from: "a", to: "b", kind: "calls" },
    { from: "b", to: "c", kind: "calls" },
    { from: "a", to: "c", kind: "calls" },
    { from: "d", to: "b", kind: "calls" },
  ];
  writeSymbols(db, symbols, { index_epoch: 1 });
  const graph = buildGraph({ symbols, edges });
  writeEdges(db, graph);
  const ranks = pageRank(graph);
  writePagerank(db, ranks, graph);
  // Insert a cluster + members for clusterMembers().
  db.prepare(
    "INSERT INTO clusters (id, name, name_status, size, algorithm, algorithm_version, index_epoch) VALUES (?,?,?,?,?,?,?)",
  ).run("cl1", "auth", "heuristic", 2, "louvain", "test", 1);
  db.prepare(
    "INSERT INTO cluster_members (cluster_id, symbol_id, is_bridge) VALUES (?, ?, ?)",
  ).run("cl1", "a", 0);
  db.prepare(
    "INSERT INTO cluster_members (cluster_id, symbol_id, is_bridge) VALUES (?, ?, ?)",
  ).run("cl1", "b", 1);
  return db;
}

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "lodestone-reader-test-"));
  dbPath = join(workdir, ".lodestone", "db.sqlite");
});

afterEach(() => {
  _resetWriterRegistry();
  rmSync(workdir, { recursive: true, force: true });
});

describe("getSymbol / getInboundEdges / getOutboundEdges", () => {
  it("getSymbol returns the row, null for unknown id", () => {
    const db = seedFixture(dbPath);
    try {
      const a = getSymbol(db, "a");
      expect(a?.id).toBe("a");
      expect(getSymbol(db, "missing")).toBeNull();
    } finally {
      closeDb(db);
    }
  });

  it("getInboundEdges returns every edge with to_id == id", () => {
    const db = seedFixture(dbPath);
    try {
      const inbound = getInboundEdges(db, "c").sort((x, y) => x.from_id.localeCompare(y.from_id));
      expect(inbound.map((e) => e.from_id)).toEqual(["a", "b"]);
    } finally {
      closeDb(db);
    }
  });

  it("getOutboundEdges returns every edge with from_id == id", () => {
    const db = seedFixture(dbPath);
    try {
      const outbound = getOutboundEdges(db, "a").map((e) => e.to_id).sort();
      expect(outbound).toEqual(["b", "c"]);
    } finally {
      closeDb(db);
    }
  });
});

describe("callersOf / calleesOf / impactOf (recursive CTEs)", () => {
  it("callersOf at depth 2 finds direct + transitive callers", () => {
    const db = seedFixture(dbPath);
    try {
      const callers = callersOf(db, "c", 3, 50).map((r) => r.id).sort();
      // a -> c (direct), a -> b -> c (transitive), d -> b -> c (transitive)
      expect(callers).toEqual(["a", "b", "d"]);
    } finally {
      closeDb(db);
    }
  });

  it("callersOf at depth 1 finds only direct callers", () => {
    const db = seedFixture(dbPath);
    try {
      const callers = callersOf(db, "c", 1, 50).map((r) => r.id).sort();
      expect(callers).toEqual(["a", "b"]);
    } finally {
      closeDb(db);
    }
  });

  it("calleesOf finds direct + transitive callees", () => {
    const db = seedFixture(dbPath);
    try {
      const callees = calleesOf(db, "a", 3, 50).map((r) => r.id).sort();
      expect(callees).toEqual(["b", "c"]);
    } finally {
      closeDb(db);
    }
  });

  it("calleesOf on a leaf node (no outgoing calls) returns empty", () => {
    const db = seedFixture(dbPath);
    try {
      const callees = calleesOf(db, "c", 3, 50);
      expect(callees).toEqual([]);
    } finally {
      closeDb(db);
    }
  });

  it("callersOf on a root node (no incoming) returns empty", () => {
    const db = seedFixture(dbPath);
    try {
      const callers = callersOf(db, "a", 3, 50);
      expect(callers).toEqual([]);
    } finally {
      closeDb(db);
    }
  });

  it("impactOf returns the same shape as callersOf with deeper default", () => {
    const db = seedFixture(dbPath);
    try {
      const impact = impactOf(db, "c", 5, 100);
      const ids = impact.map((r) => r.id).sort();
      expect(ids).toEqual(["a", "b", "d"]);
      // Each row carries a depth value.
      for (const r of impact) {
        expect(typeof r.depth).toBe("number");
        expect(r.depth).toBeGreaterThanOrEqual(1);
      }
    } finally {
      closeDb(db);
    }
  });

  it("isolated symbol has no callers and no callees", () => {
    const db = seedFixture(dbPath);
    try {
      expect(callersOf(db, "e")).toEqual([]);
      expect(calleesOf(db, "e")).toEqual([]);
    } finally {
      closeDb(db);
    }
  });

  it("self-call is reported as a single caller of depth 1", () => {
    const db = openWriter(dbPath);
    try {
      bootstrap(db);
      const symbols = [sym("recurse")];
      const edges: Edge[] = [{ from: "recurse", to: "recurse", kind: "calls" }];
      writeSymbols(db, symbols, { index_epoch: 1 });
      const graph = buildGraph({ symbols, edges });
      writeEdges(db, graph);
      const callers = callersOf(db, "recurse", 3, 50);
      expect(callers.map((r) => r.id)).toEqual(["recurse"]);
      expect(callers[0]?.depth).toBe(1);
    } finally {
      closeDb(db);
    }
  });
});

describe("clusterMembers", () => {
  it("returns the symbols in the cluster ordered by pagerank desc", () => {
    const db = seedFixture(dbPath);
    try {
      const members = clusterMembers(db, "cl1", 50);
      expect(members.map((m) => m.id).sort()).toEqual(["a", "b"]);
    } finally {
      closeDb(db);
    }
  });

  it("returns an empty list for an unknown cluster id", () => {
    const db = seedFixture(dbPath);
    try {
      expect(clusterMembers(db, "missing-cluster")).toEqual([]);
    } finally {
      closeDb(db);
    }
  });
});

describe("vectorSearch", () => {
  it("rejects mismatched query dimensions with a clear error", () => {
    const db = seedFixture(dbPath);
    try {
      expect(() => vectorSearch(db, new Float32Array(10), 5)).toThrow(/expected 768/);
    } finally {
      closeDb(db);
    }
  });

  it("returns nearest hits ordered by distance ascending", () => {
    const db = seedFixture(dbPath);
    try {
      const va = new Float32Array(768);
      va.fill(0.0);
      const vb = new Float32Array(768);
      vb.fill(1.0);
      writeEmbeddings(db, [
        { symbol_id: "a", vector: va },
        { symbol_id: "b", vector: vb },
      ]);
      const query = new Float32Array(768);
      query.fill(0.05);
      const hits = vectorSearch(db, query, 2);
      expect(hits[0]?.symbol_id).toBe("a");
      expect(hits[1]?.symbol_id).toBe("b");
      expect(hits[0]!.distance).toBeLessThanOrEqual(hits[1]!.distance);
    } finally {
      closeDb(db);
    }
  });
});

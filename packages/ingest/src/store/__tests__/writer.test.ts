// SPDX-License-Identifier: Apache-2.0
// Tests for writer.ts - symbol/edge/inheritance/embedding/pagerank inserts.
// Drives the section 7 LodestoneGraph end-to-end through buildGraph + pageRank.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ClassInheritance,
  Edge,
  EdgeRow,
  LodestoneSymbol,
  SymbolRow,
} from "@lodestone/shared";

import { buildGraph } from "../../graph/builder.js";
import { pageRank } from "../../graph/pagerank.js";
import {
  _resetWriterRegistry,
  bootstrap,
  closeDb,
  openWriter,
} from "../sqlite.js";
import {
  writeClassInheritance,
  writeEdges,
  writeEmbeddings,
  writePagerank,
  writeSymbols,
} from "../writer.js";

let workdir: string;
let dbPath: string;

function makeSymbol(over: Partial<LodestoneSymbol> & { symbol: string; path: string }): LodestoneSymbol {
  return {
    language: "typescript",
    kind: "function",
    range: { start_line: 1, end_line: 5 },
    ...over,
  };
}

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "lodestone-writer-test-"));
  dbPath = join(workdir, ".lodestone", "db.sqlite");
});

afterEach(() => {
  _resetWriterRegistry();
  rmSync(workdir, { recursive: true, force: true });
});

describe("writeSymbols", () => {
  it("inserts new symbols with the supplied epoch + commit", () => {
    const db = openWriter(dbPath);
    try {
      bootstrap(db);
      const inserted = writeSymbols(
        db,
        [
          makeSymbol({ symbol: "src/a.ts::foo", path: "src/a.ts", signature: "function foo(): void" }),
          makeSymbol({ symbol: "src/a.ts::bar", path: "src/a.ts" }),
        ],
        { index_epoch: 7, commit: "abcdef" },
      );
      expect(inserted).toBe(2);
      const rows = db.prepare("SELECT * FROM symbols ORDER BY id").all() as SymbolRow[];
      expect(rows.map((r) => r.id).sort()).toEqual(["src/a.ts::bar", "src/a.ts::foo"]);
      expect(rows[0]?.updated_at_epoch).toBe(7);
      expect(rows[0]?.updated_at_commit).toBe("abcdef");
    } finally {
      closeDb(db);
    }
  });

  it("ON CONFLICT updates the row in-place, preserving signature when null", () => {
    const db = openWriter(dbPath);
    try {
      bootstrap(db);
      writeSymbols(
        db,
        [makeSymbol({ symbol: "x", path: "src/x.ts", signature: "function x()" })],
        { index_epoch: 1, commit: null },
      );
      writeSymbols(
        db,
        [makeSymbol({ symbol: "x", path: "src/x.ts", signature: undefined })],
        { index_epoch: 2, commit: null },
      );
      const row = db.prepare("SELECT * FROM symbols WHERE id = ?").get("x") as SymbolRow;
      expect(row.signature).toBe("function x()");
      expect(row.updated_at_epoch).toBe(2);
    } finally {
      closeDb(db);
    }
  });
});

describe("writeEdges", () => {
  it("persists every internal edge from a built LodestoneGraph", () => {
    const db = openWriter(dbPath);
    try {
      bootstrap(db);
      const symbols = [
        makeSymbol({ symbol: "a", path: "a.ts" }),
        makeSymbol({ symbol: "b", path: "b.ts" }),
        makeSymbol({ symbol: "c", path: "c.ts" }),
      ];
      const edges: Edge[] = [
        { from: "a", to: "b", kind: "calls" },
        { from: "b", to: "c", kind: "calls" },
        { from: "a", to: "c", kind: "imports" },
      ];
      writeSymbols(db, symbols, { index_epoch: 1 });
      const graph = buildGraph({ symbols, edges });
      const written = writeEdges(db, graph);
      expect(written).toBe(3);
      const rows = db
        .prepare("SELECT from_id, to_id, kind, weight FROM edges ORDER BY from_id, to_id, kind")
        .all() as EdgeRow[];
      expect(rows).toEqual([
        { from_id: "a", to_id: "b", kind: "calls", weight: 1 },
        { from_id: "a", to_id: "c", kind: "imports", weight: 1 },
        { from_id: "b", to_id: "c", kind: "calls", weight: 1 },
      ]);
    } finally {
      closeDb(db);
    }
  });

  it("skips edges that touch external (stub) nodes", () => {
    const db = openWriter(dbPath);
    try {
      bootstrap(db);
      const symbols = [makeSymbol({ symbol: "a", path: "a.ts" })];
      const edges: Edge[] = [
        // 'b' is unresolved - buildGraph will stub it.
        { from: "a", to: "b", kind: "calls" },
      ];
      writeSymbols(db, symbols, { index_epoch: 1 });
      const graph = buildGraph({ symbols, edges });
      const written = writeEdges(db, graph);
      expect(written).toBe(0);
      const rows = db.prepare("SELECT * FROM edges").all();
      expect(rows.length).toBe(0);
    } finally {
      closeDb(db);
    }
  });

  it("ON CONFLICT accumulates weight across re-runs", () => {
    const db = openWriter(dbPath);
    try {
      bootstrap(db);
      const symbols = [
        makeSymbol({ symbol: "a", path: "a.ts" }),
        makeSymbol({ symbol: "b", path: "b.ts" }),
      ];
      writeSymbols(db, symbols, { index_epoch: 1 });
      const graph = buildGraph({
        symbols,
        edges: [{ from: "a", to: "b", kind: "calls", weight: 2 }],
      });
      writeEdges(db, graph);
      writeEdges(db, graph);
      const row = db
        .prepare("SELECT weight FROM edges WHERE from_id = 'a' AND to_id = 'b'")
        .get() as { weight: number };
      expect(row.weight).toBe(4);
    } finally {
      closeDb(db);
    }
  });
});

describe("writePagerank", () => {
  it("persists pagerank values from the in-memory graph", () => {
    const db = openWriter(dbPath);
    try {
      bootstrap(db);
      const symbols = [
        makeSymbol({ symbol: "a", path: "a.ts" }),
        makeSymbol({ symbol: "b", path: "b.ts" }),
      ];
      writeSymbols(db, symbols, { index_epoch: 1 });
      const graph = buildGraph({
        symbols,
        edges: [{ from: "a", to: "b", kind: "calls" }],
      });
      const ranks = pageRank(graph);
      const updated = writePagerank(db, ranks, graph);
      expect(updated).toBeGreaterThan(0);
      const row = db.prepare("SELECT pagerank FROM symbols WHERE id = 'b'").get() as {
        pagerank: number | null;
      };
      expect(typeof row.pagerank).toBe("number");
    } finally {
      closeDb(db);
    }
  });
});

describe("writeClassInheritance", () => {
  it("preserves multiple bases per class (impl-008 §08 YELLOW: composite (class_id, base_name) PK)", () => {
    const db = openWriter(dbPath);
    try {
      bootstrap(db);
      writeSymbols(
        db,
        [makeSymbol({ symbol: "a", path: "a.ts", kind: "class" })],
        { index_epoch: 1 },
      );
      writeClassInheritance(db, [
        { class_id: "a", base_name: "Base", base_path: "src/base.ts" },
      ]);
      writeClassInheritance(db, [{ class_id: "a", base_name: "Base2" }]);
      const rows = db
        .prepare(
          "SELECT base_name, base_path FROM class_inheritance WHERE class_id = 'a' ORDER BY base_name",
        )
        .all() as Array<{ base_name: string; base_path: string | null }>;
      expect(rows.map((r) => r.base_name)).toEqual(["Base", "Base2"]);
      expect(rows[0]?.base_path).toBe("src/base.ts");
      expect(rows[1]?.base_path).toBeNull();
    } finally {
      closeDb(db);
    }
  });

  it("UPSERT on (class_id, base_name) refreshes base_path", () => {
    const db = openWriter(dbPath);
    try {
      bootstrap(db);
      writeSymbols(
        db,
        [makeSymbol({ symbol: "a", path: "a.ts", kind: "class" })],
        { index_epoch: 1 },
      );
      writeClassInheritance(db, [
        { class_id: "a", base_name: "Base", base_path: "src/base.ts" },
      ]);
      writeClassInheritance(db, [
        { class_id: "a", base_name: "Base", base_path: "src/base/index.ts" },
      ]);
      const row = db
        .prepare(
          "SELECT base_name, base_path FROM class_inheritance WHERE class_id = 'a' AND base_name = 'Base'",
        )
        .get() as { base_name: string; base_path: string | null };
      expect(row.base_path).toBe("src/base/index.ts");
    } finally {
      closeDb(db);
    }
  });
});

describe("writeEmbeddings", () => {
  it("rejects vectors of the wrong dimension", () => {
    const db = openWriter(dbPath);
    try {
      bootstrap(db);
      expect(() =>
        writeEmbeddings(db, [{ symbol_id: "a", vector: new Float32Array(10) }]),
      ).toThrow(/expected 768/);
    } finally {
      closeDb(db);
    }
  });

  it("persists vectors and supports KNN search via vec0 MATCH", () => {
    const db = openWriter(dbPath);
    try {
      bootstrap(db);
      writeSymbols(
        db,
        [
          makeSymbol({ symbol: "a", path: "a.ts" }),
          makeSymbol({ symbol: "b", path: "b.ts" }),
        ],
        { index_epoch: 1 },
      );
      const a = new Float32Array(768);
      a.fill(0.1);
      const b = new Float32Array(768);
      b.fill(0.9);
      writeEmbeddings(db, [
        { symbol_id: "a", vector: a },
        { symbol_id: "b", vector: b },
      ]);
      const query = new Float32Array(768);
      query.fill(0.11);
      const rows = db
        .prepare(
          "SELECT symbol_id, distance FROM symbol_embeddings WHERE embedding MATCH ? AND k = 2 ORDER BY distance",
        )
        .all(Buffer.from(query.buffer, query.byteOffset, query.byteLength)) as Array<{
        symbol_id: string;
        distance: number;
      }>;
      expect(rows[0]?.symbol_id).toBe("a");
    } finally {
      closeDb(db);
    }
  });
});

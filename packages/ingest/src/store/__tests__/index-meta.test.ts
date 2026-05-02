// SPDX-License-Identifier: Apache-2.0
// Tests for index-meta.ts and the impl-008 RED #1/#2/#3 fixes.
//
// RED #1: ready.json↔SQLite epoch oracle. Verifies that `assertReaderReady`
// catches a stale ready.json (pointing at an epoch the DB never reached) AND
// the reverse (DB committed a fresh epoch but ready.json was never renamed).
//
// RED #2: clean reindex replacement. Verifies `beginReindex` wipes prior
// rows so two consecutive identical reindexes do not double edge weights or
// leave orphan symbols.
//
// RED #3: embedder dim awareness. Verifies that `writeEmbeddings` accepts
// 384-dim vectors when `index_meta.embedder_dim = 384` was stamped first,
// and rejects any other dim with a descriptive error.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Edge, LodestoneSymbol } from "@lodestone/shared";

import { buildGraph } from "../../graph/builder.js";
import {
  _resetWriterRegistry,
  bootstrap,
  closeDb,
  openWriter,
  vecLoadError,
} from "../sqlite.js";
import {
  beginReindex,
  getCurrentEpoch,
  getEmbedderIdentity,
  readIndexMeta,
  writeIndexMeta,
} from "../index-meta.js";
import {
  writeEdges,
  writeEmbeddings,
  writeSymbols,
} from "../writer.js";
import {
  assertReaderReady,
  writeReady,
} from "../ready.js";

let workdir: string;
let lodestoneDir: string;
let dbPath: string;

function sym(id: string, p: string): LodestoneSymbol {
  return {
    symbol: id,
    path: p,
    language: "typescript",
    kind: "function",
    range: { start_line: 1, end_line: 5 },
  };
}

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "lodestone-index-meta-test-"));
  lodestoneDir = join(workdir, ".lodestone");
  mkdirSync(lodestoneDir, { recursive: true });
  dbPath = join(lodestoneDir, "lodestone.sqlite");
});

afterEach(() => {
  _resetWriterRegistry();
  rmSync(workdir, { recursive: true, force: true });
});

describe("readIndexMeta + bootstrap", () => {
  it("creates the singleton row at bootstrap with current_epoch=0 and NULL embedder fields", () => {
    const db = openWriter(dbPath);
    try {
      bootstrap(db);
      const meta = readIndexMeta(db);
      expect(meta).not.toBeNull();
      expect(meta?.id).toBe(1);
      expect(meta?.current_epoch).toBe(0);
      expect(meta?.embedder_id).toBeNull();
      expect(meta?.embedder_dim).toBeNull();
      expect(meta?.embedder_quant).toBeNull();
    } finally {
      closeDb(db);
    }
  });

  it("getCurrentEpoch returns 0 on a fresh bootstrap", () => {
    const db = openWriter(dbPath);
    try {
      bootstrap(db);
      expect(getCurrentEpoch(db)).toBe(0);
    } finally {
      closeDb(db);
    }
  });

  it("getEmbedderIdentity returns null until an identity is stamped", () => {
    const db = openWriter(dbPath);
    try {
      bootstrap(db);
      expect(getEmbedderIdentity(db)).toBeNull();
    } finally {
      closeDb(db);
    }
  });
});

describe("writeIndexMeta + getEmbedderIdentity", () => {
  it("records the embedder identity and surfaces it on read", () => {
    const db = openWriter(dbPath);
    try {
      bootstrap(db);
      writeIndexMeta(db, 7, { id: "snowflake-arctic-embed-s", dim: 384, quant: "fp32" });
      expect(getCurrentEpoch(db)).toBe(7);
      expect(getEmbedderIdentity(db)).toEqual({
        id: "snowflake-arctic-embed-s",
        dim: 384,
        quant: "fp32",
      });
    } finally {
      closeDb(db);
    }
  });
});

describe("RED #1 — assertReaderReady cross-store epoch oracle", () => {
  it("succeeds when ready.json and index_meta agree", () => {
    const db = openWriter(dbPath);
    try {
      bootstrap(db);
      writeIndexMeta(db, 3, { id: "nomic-embed-text-v1.5", dim: 768, quant: "int8" });
      writeReady(lodestoneDir, {
        schema_version: 2,
        lodestone_version: "0.1.1",
        ready: true,
        embedder: { id: "nomic-embed-text-v1.5", dim: 768, quant: "int8" },
        languages_indexed: ["typescript"],
        indexed_at: "2026-05-02T00:00:00Z",
        commit_at_index: null,
        dirty_at_index: false,
        index_epoch: 3,
        writer_pid: process.pid,
      });
      expect(() => assertReaderReady(db, lodestoneDir)).not.toThrow();
    } finally {
      closeDb(db);
    }
  });

  it("throws when ready.json points to an epoch the DB never reached", () => {
    const db = openWriter(dbPath);
    try {
      bootstrap(db);
      // DB is at epoch 3, ready.json claims epoch 4 (stale ready.json from
      // a prior pass that crashed mid-rename, or a malicious flip).
      writeIndexMeta(db, 3, { id: "nomic-embed-text-v1.5", dim: 768, quant: "int8" });
      writeReady(lodestoneDir, {
        schema_version: 2,
        lodestone_version: "0.1.1",
        ready: true,
        embedder: { id: "nomic-embed-text-v1.5", dim: 768, quant: "int8" },
        languages_indexed: ["typescript"],
        indexed_at: "2026-05-02T00:00:00Z",
        commit_at_index: null,
        dirty_at_index: false,
        index_epoch: 4,
        writer_pid: process.pid,
      });
      expect(() => assertReaderReady(db, lodestoneDir)).toThrow(/epoch mismatch/i);
    } finally {
      closeDb(db);
    }
  });

  it("throws when DB committed a fresh epoch but ready.json was never updated", () => {
    const db = openWriter(dbPath);
    try {
      bootstrap(db);
      // First successful pass at epoch 1.
      writeIndexMeta(db, 1, { id: "nomic-embed-text-v1.5", dim: 768, quant: "int8" });
      writeReady(lodestoneDir, {
        schema_version: 2,
        lodestone_version: "0.1.1",
        ready: true,
        embedder: { id: "nomic-embed-text-v1.5", dim: 768, quant: "int8" },
        languages_indexed: ["typescript"],
        indexed_at: "2026-05-02T00:00:00Z",
        commit_at_index: null,
        dirty_at_index: false,
        index_epoch: 1,
        writer_pid: process.pid,
      });
      // Reindex bumped DB to 2 but ready.json is still 1 (mid-flight crash
      // before the writeReady call).
      writeIndexMeta(db, 2, { id: "nomic-embed-text-v1.5", dim: 768, quant: "int8" });
      expect(() => assertReaderReady(db, lodestoneDir)).toThrow(/epoch mismatch/i);
    } finally {
      closeDb(db);
    }
  });

  it("throws when ready.json is missing entirely", () => {
    const db = openWriter(dbPath);
    try {
      bootstrap(db);
      writeIndexMeta(db, 1, { id: "nomic-embed-text-v1.5", dim: 768, quant: "int8" });
      expect(() => assertReaderReady(db, lodestoneDir)).toThrow(/no ready\.json|not ready/i);
    } finally {
      closeDb(db);
    }
  });

  // Codex r2 §08 PARTIAL — identity-null bypass closed.
  it("still enforces epoch comparison when index_meta exists but embedder identity is NULL", () => {
    const db = openWriter(dbPath);
    try {
      bootstrap(db);
      // bootstrap() populates index_meta with current_epoch=0 + NULL identity.
      // ready.json claims epoch=5 — pre-r2 this would have passed via the
      // identity-null shim. r2 narrows the shim: identity-null + table-present
      // must still trip the epoch oracle.
      writeReady(lodestoneDir, {
        schema_version: 2,
        lodestone_version: "0.1.3",
        ready: true,
        embedder: { id: "nomic-embed-text-v1.5", dim: 768, quant: "int8" },
        languages_indexed: ["typescript"],
        indexed_at: "2026-05-02T00:00:00Z",
        commit_at_index: null,
        dirty_at_index: false,
        index_epoch: 5,
        writer_pid: process.pid,
      });
      expect(() => assertReaderReady(db, lodestoneDir)).toThrow(/epoch mismatch/i);
    } finally {
      closeDb(db);
    }
  });

  // Codex r2 §08 PARTIAL — true legacy DB shim still works (no index_meta table).
  it("falls back to marker-only check when index_meta table is absent (true pre-v0.1.2 DB)", () => {
    const db = openWriter(dbPath);
    try {
      // Skip bootstrap() — simulate a legacy DB that predates migration 002.
      db.prepare("DROP TABLE IF EXISTS index_meta").run();
      writeReady(lodestoneDir, {
        schema_version: 1,
        lodestone_version: "0.1.0",
        ready: true,
        embedder: { id: "nomic-embed-text-v1.5", dim: 768, quant: "int8" },
        languages_indexed: ["typescript"],
        indexed_at: "2026-05-02T00:00:00Z",
        commit_at_index: null,
        dirty_at_index: false,
        index_epoch: 9,
        writer_pid: process.pid,
      });
      // No index_meta → no DB side to compare → marker-only path. Should pass.
      expect(() => assertReaderReady(db, lodestoneDir)).not.toThrow();
    } finally {
      closeDb(db);
    }
  });
});

describe("RED #2 — beginReindex clean replacement", () => {
  it("wipes prior symbols, edges, and embeddings before the new pass", () => {
    const db = openWriter(dbPath);
    try {
      bootstrap(db);
      // First pass: 2 symbols + 1 edge.
      const epoch1 = beginReindex(db, { id: "test-embed", dim: 8, quant: "fp32" });
      expect(epoch1).toBe(1);
      const symbols1 = [sym("a", "a.ts"), sym("b", "b.ts")];
      writeSymbols(db, symbols1, { index_epoch: epoch1 });
      const g1 = buildGraph({
        symbols: symbols1,
        edges: [{ from: "a", to: "b", kind: "calls", weight: 2 }],
      });
      writeEdges(db, g1);
      writeEmbeddings(db, [
        { symbol_id: "a", vector: new Float32Array(8).fill(0.1) },
      ]);

      // Second pass: only 1 symbol, no edges. Old "b" symbol + a→b edge +
      // "a" embedding must be gone.
      const epoch2 = beginReindex(db, { id: "test-embed", dim: 8, quant: "fp32" });
      expect(epoch2).toBe(2);
      const symbols2 = [sym("c", "c.ts")];
      writeSymbols(db, symbols2, { index_epoch: epoch2 });

      const remainingSymbols = (db
        .prepare("SELECT id FROM symbols ORDER BY id")
        .all() as { id: string }[]).map((r) => r.id);
      expect(remainingSymbols).toEqual(["c"]);

      const remainingEdges = db.prepare("SELECT COUNT(*) AS c FROM edges").get() as { c: number };
      expect(remainingEdges.c).toBe(0);

      const remainingVecs = db.prepare("SELECT COUNT(*) AS c FROM symbol_embeddings").get() as { c: number };
      expect(remainingVecs.c).toBe(0);
    } finally {
      closeDb(db);
    }
  });

  it("does NOT double edge weights when the same graph is re-indexed", () => {
    const db = openWriter(dbPath);
    try {
      bootstrap(db);
      const symbols = [sym("a", "a.ts"), sym("b", "b.ts")];
      const g = buildGraph({
        symbols,
        edges: [{ from: "a", to: "b", kind: "calls", weight: 3 }],
      });

      const epoch1 = beginReindex(db, { id: "test-embed", dim: 8, quant: "fp32" });
      writeSymbols(db, symbols, { index_epoch: epoch1 });
      writeEdges(db, g);

      const epoch2 = beginReindex(db, { id: "test-embed", dim: 8, quant: "fp32" });
      writeSymbols(db, symbols, { index_epoch: epoch2 });
      writeEdges(db, g);

      const row = db
        .prepare("SELECT weight FROM edges WHERE from_id = \'a\' AND to_id = \'b\'")
        .get() as { weight: number };
      // Without the wipe, on-conflict-accumulate would produce 6.0; with the
      // wipe, the second pass starts from empty so weight stays at 3.0.
      expect(row.weight).toBe(3);
    } finally {
      closeDb(db);
    }
  });

  it("monotonically allocates fresh epochs across passes", () => {
    const db = openWriter(dbPath);
    try {
      bootstrap(db);
      const e1 = beginReindex(db, { id: "test", dim: 8, quant: "fp32" });
      const e2 = beginReindex(db, { id: "test", dim: 8, quant: "fp32" });
      const e3 = beginReindex(db, { id: "test", dim: 8, quant: "fp32" });
      expect(e1).toBe(1);
      expect(e2).toBe(2);
      expect(e3).toBe(3);
      expect(getCurrentEpoch(db)).toBe(3);
    } finally {
      closeDb(db);
    }
  });
});

describe("RED #3 — embedder dim awareness in writeEmbeddings", () => {
  it("accepts 384-dim vectors after a 384-dim embedder identity is stamped", () => {
    const db = openWriter(dbPath);
    try {
      bootstrap(db);
      beginReindex(db, { id: "snowflake-arctic-embed-s", dim: 384, quant: "fp32" });
      writeSymbols(db, [sym("a", "a.ts")], { index_epoch: 1 });
      const v = new Float32Array(384).fill(0.5);
      expect(() => writeEmbeddings(db, [{ symbol_id: "a", vector: v }])).not.toThrow();
    } finally {
      closeDb(db);
    }
  });

  it("rejects a 768-dim vector against a 384-dim identity with a clear error", () => {
    const db = openWriter(dbPath);
    try {
      bootstrap(db);
      beginReindex(db, { id: "snowflake-arctic-embed-s", dim: 384, quant: "fp32" });
      writeSymbols(db, [sym("a", "a.ts")], { index_epoch: 1 });
      const v = new Float32Array(768).fill(0.5);
      expect(() => writeEmbeddings(db, [{ symbol_id: "a", vector: v }])).toThrow(
        /expected 384/,
      );
    } finally {
      closeDb(db);
    }
  });

  it("rejects a 384-dim vector against the default 768 dim (no identity stamped)", () => {
    const db = openWriter(dbPath);
    try {
      bootstrap(db);
      writeSymbols(db, [sym("a", "a.ts")], { index_epoch: 1 });
      const v = new Float32Array(384).fill(0.5);
      expect(() => writeEmbeddings(db, [{ symbol_id: "a", vector: v }])).toThrow(
        /expected 768/,
      );
    } finally {
      closeDb(db);
    }
  });
});


describe("§08 YELLOW — sqlite-vec degrade", () => {
  it("vecLoadError returns null when extension loaded successfully", () => {
    const db = openWriter(dbPath);
    try {
      bootstrap(db);
      // The store opens with loadVec=true by default; sqlite-vec ships a
      // platform binary in the test toolchain, so the load should succeed.
      // The point of this test is to assert the helper exists and returns
      // null on the happy path — the degraded path is exercised in unit
      // tests that mock the loader (out of scope here).
      expect(vecLoadError(db)).toBeNull();
    } finally {
      closeDb(db);
    }
  });
});

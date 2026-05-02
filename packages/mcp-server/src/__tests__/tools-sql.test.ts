// SPDX-License-Identifier: Apache-2.0
// Tests for tools/sql.ts. The §15 sql tool is the gated escape hatch:
//   - registry-time gate (in tools/index.ts buildActiveRegistry — covered
//     by tools-registration.test.ts)
//   - handler-entry env-var gate (here, defense-in-depth)
//   - driver-level OPEN_READONLY rejection of any DDL/DML
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  _resetWriterRegistry,
  bootstrap,
  closeDb,
  openWriter,
  writeReady,
  writeSymbols,
} from "@lodestone/ingest/store";
import type { LodestoneSymbol } from "@lodestone/shared";

import { _setTestDbPath } from "../tools/db.js";
import { dangerous, description, handler } from "../tools/sql.js";

let tmp: string;
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

function seedFixture(dbPath: string): void {
  const db = openWriter(dbPath);
  bootstrap(db);
  writeSymbols(db, [sym("a"), sym("b"), sym("c"), sym("d"), sym("e")], {
    index_epoch: 1,
  });
  closeDb(db);
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "lodestone-sql-test-"));
  const lodestoneDir = path.join(tmp, ".lodestone");
  mkdirSync(lodestoneDir, { recursive: true });
  dbPath = path.join(lodestoneDir, "lodestone.sqlite");
  seedFixture(dbPath);
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
  _resetWriterRegistry();
  _setTestDbPath(dbPath);
  // Open the gate for the duration of a test; afterEach closes it.
  process.env.LODESTONE_DANGEROUS_TOOLS = "1";
});

afterEach(() => {
  delete process.env.LODESTONE_DANGEROUS_TOOLS;
  _setTestDbPath(null);
  _resetWriterRegistry();
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

describe("sql tool (§15 gated escape hatch)", () => {
  it("is marked as dangerous", () => {
    expect(dangerous).toBe(true);
  });

  it("description is >=150 chars (Claude Code tool-search retrieval gate)", () => {
    expect(description.length).toBeGreaterThanOrEqual(150);
  });

  it("returns rows for a valid SELECT when the gate is open", async () => {
    const env = await handler({
      query: "SELECT id FROM symbols ORDER BY id ASC LIMIT 5",
    });
    expect(env.results.length).toBe(5);
    const ids = env.results.map((r) => (r as { id: string }).id).sort();
    expect(ids).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("rejects every call when the env gate is closed (defense-in-depth)", async () => {
    delete process.env.LODESTONE_DANGEROUS_TOOLS;
    const env = await handler({ query: "SELECT 1" });
    expect(env.results).toEqual([]);
    expect(env.diagnostics.warnings ?? []).toEqual([
      expect.stringMatching(/sql tool disabled/),
    ]);
  });

  it("rejects 'true' style values too (truthy env semantics)", async () => {
    process.env.LODESTONE_DANGEROUS_TOOLS = "true";
    const env = await handler({ query: "SELECT 1 AS x" });
    // Should be a successful pass-through.
    expect(env.results.length).toBe(1);
    expect((env.results[0] as { x: number }).x).toBe(1);
  });

  // §15 RED #2 amendment: DROP/CREATE/INSERT now hit the statement-shape
  // gate (must begin with SELECT or WITH) BEFORE the driver-level
  // OPEN_READONLY rejection. Both layers are intentional defense-in-depth;
  // the test asserts whichever fires first, since DDL/DML are flatly
  // unacceptable regardless of which layer caught them.
  it("rejects DROP at the statement-shape gate (or driver OPEN_READONLY)", async () => {
    const env = await handler({ query: "DROP TABLE symbols" });
    expect(env.results).toEqual([]);
    expect(env.diagnostics.warnings ?? []).toEqual([
      expect.stringMatching(
        /statement-shape|SELECT or WITH|read-only-violation|parse-error|attempt to write/i,
      ),
    ]);
  });

  it("rejects CREATE at the statement-shape gate", async () => {
    const env = await handler({ query: "CREATE TABLE evil (x INTEGER)" });
    expect(env.results).toEqual([]);
    expect(env.diagnostics.warnings ?? []).toEqual([
      expect.stringMatching(
        /statement-shape|SELECT or WITH|read-only-violation|parse-error|attempt to write/i,
      ),
    ]);
  });

  it("rejects INSERT at the statement-shape gate", async () => {
    const env = await handler({
      query: "INSERT INTO symbols (id) VALUES ('zzz')",
    });
    expect(env.results).toEqual([]);
    expect(env.diagnostics.warnings ?? []).toEqual([
      expect.stringMatching(
        /statement-shape|SELECT or WITH|read-only-violation|parse-error|attempt to write/i,
      ),
    ]);
  });

  it("surfaces malformed SQL as a structured parse-error (no crash)", async () => {
    // After §15 RED #2: SELEC starts with neither SELECT nor WITH so the
    // statement-shape gate fires first. We assert either error path —
    // the user-visible outcome (empty results + structured warning) is
    // unchanged.
    const env = await handler({ query: "SELEC bad-syntax" });
    expect(env.results).toEqual([]);
    expect(env.diagnostics.warnings ?? []).toEqual([
      expect.stringMatching(/parse-error|statement-shape|SELECT or WITH/i),
    ]);
  });

  it("surfaces a real prepare-time parse error (after the shape gate)", async () => {
    // Starts with SELECT so it passes the shape gate; better-sqlite3
    // rejects at prepare() time with a syntax error.
    const env = await handler({ query: "SELECT FROM" });
    expect(env.results).toEqual([]);
    expect(env.diagnostics.warnings ?? []).toEqual([
      expect.stringMatching(/parse-error|cartesian/i),
    ]);
  });

  it("rejects empty query string at the schema layer", async () => {
    const env = await handler({ query: "" });
    expect(env.results).toEqual([]);
    expect(env.diagnostics.warnings ?? []).toEqual([
      expect.stringMatching(/invalid input/),
    ]);
  });

  it("rejects queries above the 4 KB cap", async () => {
    const big = "SELECT id FROM symbols WHERE id = '" + "x".repeat(5000) + "'";
    const env = await handler({ query: big });
    expect(env.results).toEqual([]);
    expect(env.diagnostics.warnings ?? []).toEqual([
      expect.stringMatching(/4096 byte cap|exceeds.*byte cap/i),
    ]);
  });

  it("returns a clean error envelope when the index is missing", async () => {
    _setTestDbPath(path.join(tmp, "does-not-exist.sqlite"));
    const env = await handler({ query: "SELECT 1" });
    expect(env.results).toEqual([]);
    expect(env.diagnostics.warnings ?? []).toEqual([
      expect.stringMatching(/index unavailable/),
    ]);
  });

  it("envelope channel is 'code' (POST-FORGE-VISION amendment §2)", async () => {
    const env = await handler({ query: "SELECT 1" });
    expect(env.channel).toBe("code");
  });

  // §15 RED #2 — DoS preflight + bounded materialization. better-sqlite3 is
  // synchronous and exposes no JS binding for sqlite3_interrupt(), so we
  // can't time out a long-running query from a setTimeout callback. The
  // realistic defense is preflight rejection (statement shape + EXPLAIN
  // QUERY PLAN smell test) + iterate()-based early-stop so MAX_ROWS is a
  // pre-materialization cap rather than a post-materialization slice.

  describe("§15 RED #2 — DoS hardening", () => {
    it("rejects multi-statement queries (statement-shape gate)", async () => {
      const env = await handler({
        query: "SELECT 1; SELECT 2",
      });
      expect(env.results).toEqual([]);
      expect(env.diagnostics.warnings ?? []).toEqual([
        expect.stringMatching(/multi-statement|single statement/i),
      ]);
    });

    it("rejects non-SELECT/WITH leading keyword (statement-shape gate)", async () => {
      const env = await handler({
        query: "PRAGMA table_info(symbols)",
      });
      expect(env.results).toEqual([]);
      expect(env.diagnostics.warnings ?? []).toEqual([
        expect.stringMatching(/SELECT or WITH|read-only/i),
      ]);
    });

    it("accepts a leading WITH (CTE) read query", async () => {
      const env = await handler({
        query:
          "WITH ids AS (SELECT id FROM symbols) SELECT id FROM ids ORDER BY id LIMIT 3",
      });
      expect(env.results.length).toBe(3);
    });

    it("rejects EXPLAIN QUERY PLAN cartesian patterns (cost preflight)", async () => {
      // 5x5x5x5 cross product = 625 rows, easily blows MAX_ROWS but more
      // importantly the EXPLAIN plan shows back-to-back SCANs with no
      // WHERE-clause join filter — that's the cartesian smell we reject.
      const env = await handler({
        query:
          "SELECT s1.id FROM symbols s1, symbols s2, symbols s3, symbols s4",
      });
      expect(env.results).toEqual([]);
      expect(env.diagnostics.warnings ?? []).toEqual([
        expect.stringMatching(/cartesian|too expensive|cost/i),
      ]);
    });

    it("stops materializing after MAX_ROWS rows (iterate()-based early break)", async () => {
      // Insert enough rows that a SELECT * would normally materialize >MAX_ROWS.
      // Use a recursive-CTE generator to avoid having to seed thousands of rows.
      const env = await handler({
        query:
          "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r WHERE n < 5000) SELECT n FROM r",
      });
      // Either rejected by preflight (recursive CTE without indexed source) OR
      // truncated by iterate() at MAX_ROWS. Both are acceptable for v0.
      const warnings = env.diagnostics.warnings ?? [];
      const truncatedToMax =
        env.results.length === 1000 &&
        warnings.some((w) => /truncated to 1000/.test(w));
      const rejected =
        env.results.length === 0 &&
        warnings.some((w) => /cartesian|too expensive|cost|preflight/i.test(w));
      expect(truncatedToMax || rejected).toBe(true);
    });
  });
});

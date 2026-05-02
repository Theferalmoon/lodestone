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

  it("rejects DROP at the driver level (OPEN_READONLY)", async () => {
    const env = await handler({ query: "DROP TABLE symbols" });
    expect(env.results).toEqual([]);
    expect(env.diagnostics.warnings ?? []).toEqual([
      expect.stringMatching(/read-only-violation|parse-error|attempt to write/i),
    ]);
  });

  it("rejects CREATE at the driver level", async () => {
    const env = await handler({ query: "CREATE TABLE evil (x INTEGER)" });
    expect(env.results).toEqual([]);
    expect(env.diagnostics.warnings ?? []).toEqual([
      expect.stringMatching(/read-only-violation|parse-error|attempt to write/i),
    ]);
  });

  it("rejects INSERT at the driver level", async () => {
    const env = await handler({
      query: "INSERT INTO symbols (id) VALUES ('zzz')",
    });
    expect(env.results).toEqual([]);
    expect(env.diagnostics.warnings ?? []).toEqual([
      expect.stringMatching(/read-only-violation|parse-error|attempt to write/i),
    ]);
  });

  it("surfaces malformed SQL as a structured parse-error (no crash)", async () => {
    const env = await handler({ query: "SELEC bad-syntax" });
    expect(env.results).toEqual([]);
    expect(env.diagnostics.warnings ?? []).toEqual([
      expect.stringMatching(/parse-error/),
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
});

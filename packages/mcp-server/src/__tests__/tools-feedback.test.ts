// SPDX-License-Identifier: Apache-2.0
// §17 — feedback tool tests. Drives the handler against a temp .lodestone/
// SQLite database; covers validation, persistence, request_id linkage (the
// load-bearing field for v0.5 specialty-agent training-pair extraction), note
// truncation, channel discriminant, and trust-boundary semantics (the writer
// handle is opened/closed per call, never held open).

import { mkdtempSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _resetWriterRegistry,
  bootstrap,
  closeDb,
  openReader,
  openWriter,
} from "@lodestone/ingest/store";
import type { FeedbackRow } from "@lodestone/shared";
import { lodestoneSubpath } from "@lodestone/shared";

import {
  _resetCachedWriters,
  description,
  handler as productionHandler,
  inputSchema,
  makeHandler,
  NOTE_MAX_BYTES,
  truncateNote,
  type FeedbackAck,
} from "../tools/feedback.js";
import type { LodestoneToolResponseV13 } from "../envelope.js";

let workdir: string;
let dbPath: string;

beforeEach(() => {
  workdir = mkdtempSync(path.join(tmpdir(), "lodestone-feedback-"));
  // Pre-create .lodestone/ so the handler's first call hits an existing dir.
  mkdirSync(path.join(workdir, ".lodestone"), { recursive: true });
  dbPath = lodestoneSubpath(workdir, "sqlite");
  // Pre-bootstrap so we exercise the "schema already exists" fast path.
  const w = openWriter(dbPath);
  bootstrap(w);
  closeDb(w);
  _resetWriterRegistry();
  _resetCachedWriters();
});

afterEach(() => {
  // Release the cached feedback writer FIRST so the §08 registry reset finds
  // an empty pool (the cached writer holds an entry in the registry).
  _resetCachedWriters();
  _resetWriterRegistry();
  try {
    rmSync(workdir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function readAllRows(): FeedbackRow[] {
  const db = openReader(dbPath, { loadVec: false });
  try {
    return db
      .prepare("SELECT id, recorded_at, tool, request_id, signal, note FROM feedback ORDER BY id")
      .all() as FeedbackRow[];
  } finally {
    db.close();
  }
}

describe("description", () => {
  it("is at least 150 chars (Claude Code tool-search retrieval gate)", () => {
    expect(description.length).toBeGreaterThanOrEqual(150);
  });

  it("mentions every read-tool name to maximize retrieval signal", () => {
    for (const tool of ["query", "cluster", "context"]) {
      expect(description).toContain(tool);
    }
  });
});

describe("inputSchema", () => {
  it("accepts a minimal valid input", () => {
    const result = inputSchema.safeParse({
      tool: "query",
      request_id: "01900000-0000-7000-8000-000000000000",
      signal: "useful",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown signal literal", () => {
    const result = inputSchema.safeParse({
      tool: "query",
      request_id: "x",
      signal: "amazing",
    });
    expect(result.success).toBe(false);
  });

  it("requires a non-empty request_id", () => {
    const result = inputSchema.safeParse({
      tool: "query",
      request_id: "",
      signal: "useful",
    });
    expect(result.success).toBe(false);
  });

  it("requires a non-empty tool name", () => {
    const result = inputSchema.safeParse({
      tool: "",
      request_id: "x",
      signal: "useful",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-`code` channel literal at the schema layer", () => {
    const result = inputSchema.safeParse({
      tool: "query",
      request_id: "x",
      signal: "useful",
      channel: "ops",
    });
    expect(result.success).toBe(false);
  });
});

describe("truncateNote", () => {
  it("returns the original note untouched when under the cap", () => {
    const { value, truncated } = truncateNote("hello");
    expect(value).toBe("hello");
    expect(truncated).toBe(false);
  });

  it("truncates oversized ASCII to NOTE_MAX_BYTES", () => {
    const big = "a".repeat(NOTE_MAX_BYTES + 100);
    const { value, truncated } = truncateNote(big);
    expect(truncated).toBe(true);
    expect(new TextEncoder().encode(value).byteLength).toBeLessThanOrEqual(NOTE_MAX_BYTES);
  });

  it("does not throw on a multi-byte codepoint split mid-byte", () => {
    // Build a string whose byte length straddles the cap with a 4-byte emoji.
    const filler = "a".repeat(NOTE_MAX_BYTES - 2);
    const tricky = filler + "\u{1F600}\u{1F600}"; // each emoji = 4 UTF-8 bytes
    const { value, truncated } = truncateNote(tricky);
    expect(truncated).toBe(true);
    expect(typeof value).toBe("string");
  });
});

describe("handler — happy path", () => {
  it("persists a row and returns {ack:true, id, recorded_at}", async () => {
    const handler = makeHandler({ cwd: workdir, now: () => "2026-05-01T12:00:00.000Z" });
    const env = (await handler({
      tool: "query",
      request_id: "01900000-0000-7000-8000-000000000000",
      signal: "useful",
    })) as LodestoneToolResponseV13<FeedbackAck>;

    expect(env.channel).toBe("code");
    expect(env.diagnostics.warnings ?? []).not.toContain("not_implemented");
    expect(env.results).toHaveLength(1);
    expect(env.results[0]?.ack).toBe(true);
    expect(env.results[0]?.id).toBeGreaterThan(0);
    expect(env.results[0]?.recorded_at).toBe("2026-05-01T12:00:00.000Z");

    const rows = readAllRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tool: "query",
      request_id: "01900000-0000-7000-8000-000000000000",
      signal: "useful",
      note: null,
      recorded_at: "2026-05-01T12:00:00.000Z",
    });
  });

  it("preserves the request_id field exactly — load-bearing for v0.5 training-pair extraction", async () => {
    const handler = makeHandler({ cwd: workdir });
    const linkedId = "01900000-DEAD-7BEE-8000-FEEDF00DCAFE";
    await handler({ tool: "cluster", request_id: linkedId, signal: "wrong" });
    const rows = readAllRows();
    expect(rows[0]?.request_id).toBe(linkedId);
  });

  it("persists each of the four signal literals", async () => {
    const handler = makeHandler({ cwd: workdir });
    for (const signal of ["useful", "not_useful", "wrong", "stale"] as const) {
      await handler({ tool: "query", request_id: `req-${signal}`, signal });
    }
    const rows = readAllRows();
    expect(rows.map((r) => r.signal).sort()).toEqual(["not_useful", "stale", "useful", "wrong"]);
  });

  it("stores the note when supplied and within the cap", async () => {
    const handler = makeHandler({ cwd: workdir });
    await handler({
      tool: "query",
      request_id: "req-1",
      signal: "useful",
      note: "this nailed the import I needed",
    });
    const rows = readAllRows();
    expect(rows[0]?.note).toBe("this nailed the import I needed");
  });

  it("truncates an oversized note and surfaces a diagnostics warning", async () => {
    const handler = makeHandler({ cwd: workdir });
    const big = "x".repeat(NOTE_MAX_BYTES + 500);
    const env = (await handler({
      tool: "query",
      request_id: "req-big",
      signal: "not_useful",
      note: big,
    })) as LodestoneToolResponseV13<FeedbackAck>;

    expect(env.results[0]?.ack).toBe(true);
    const warnings = env.diagnostics.warnings ?? [];
    expect(warnings.some((w) => w.includes("truncated"))).toBe(true);

    const rows = readAllRows();
    expect(rows[0]?.note?.length).toBeLessThanOrEqual(NOTE_MAX_BYTES);
  });
});

describe("handler — validation failures return structured envelopes (never throw)", () => {
  it("rejects an unknown signal with a clear error envelope", async () => {
    const handler = makeHandler({ cwd: workdir });
    const env = (await handler({
      tool: "query",
      request_id: "req-x",
      signal: "amazing",
    })) as LodestoneToolResponseV13<FeedbackAck>;
    expect(env.results).toEqual([]);
    expect(env.diagnostics.warnings?.some((w) => w.includes("validation failed"))).toBe(true);
    expect(env.channel).toBe("code");
    expect(readAllRows()).toHaveLength(0);
  });

  it("rejects missing request_id (the link to the prior tool call)", async () => {
    const handler = makeHandler({ cwd: workdir });
    const env = (await handler({
      tool: "query",
      signal: "useful",
    })) as LodestoneToolResponseV13<FeedbackAck>;
    expect(env.results).toEqual([]);
    expect(env.diagnostics.warnings?.some((w) => w.includes("validation failed"))).toBe(true);
  });

  it("rejects missing tool name", async () => {
    const handler = makeHandler({ cwd: workdir });
    const env = (await handler({
      request_id: "req-x",
      signal: "useful",
    })) as LodestoneToolResponseV13<FeedbackAck>;
    expect(env.results).toEqual([]);
    expect(env.diagnostics.warnings?.some((w) => w.includes("validation failed"))).toBe(true);
  });

  it("rejects a non-object input without throwing", async () => {
    const handler = makeHandler({ cwd: workdir });
    const env = (await handler("not an object")) as LodestoneToolResponseV13<FeedbackAck>;
    expect(env.results).toEqual([]);
    expect(env.diagnostics.warnings?.some((w) => w.includes("validation failed"))).toBe(true);
  });
});

describe("handler — writer caching + serialization (v0.1.1, impl-017 B2)", () => {
  it("re-opens after an external close (handle stays valid for the lifetime of the handler module)", async () => {
    // v0.1.1 contract: the handler caches a writer at module scope and reuses
    // it across calls. If the cached writer is externally closed (test reset,
    // signal handler), the next handler call lazily re-opens — verified here
    // by calling handler twice, with a deliberate cache flush in between.
    const handler = makeHandler({ cwd: workdir });
    await handler({ tool: "query", request_id: "a", signal: "useful" });

    // Simulate the writer being torn down (e.g. server shutdown then restart
    // within the same process). The cached writer entry must be re-opened on
    // the next call.
    _resetCachedWriters();
    _resetWriterRegistry();

    await handler({ tool: "query", request_id: "b", signal: "useful" });
    expect(readAllRows()).toHaveLength(2);
  });

  it("persists across simulated MCP server restarts (handler invocations) — the file is the source of truth", async () => {
    const h1 = makeHandler({ cwd: workdir });
    await h1({ tool: "query", request_id: "first", signal: "useful" });

    // Drop the cached writer + the §08 registry as if the server process
    // exited and restarted. The next handler call must lazily re-open.
    _resetCachedWriters();
    _resetWriterRegistry();

    const h2 = makeHandler({ cwd: workdir });
    await h2({ tool: "context", request_id: "second", signal: "stale" });

    const rows = readAllRows();
    expect(rows.map((r) => r.request_id)).toEqual(["first", "second"]);
  });

  it("ten concurrent calls all land — no §08 writerRegistry collision (impl-017 B2 spec)", async () => {
    // The §17 original implementation opened a writer per call. Two calls
    // racing each other tripped the §08 writerRegistry "writer already open"
    // guard. v0.1.1 fixes this by caching the writer module-scope and
    // serializing writes through a per-path Promise chain.
    const handler = makeHandler({ cwd: workdir });
    const concurrent = Array.from({ length: 10 }, (_, i) =>
      handler({
        tool: "query",
        request_id: `concurrent-${i}`,
        signal: "useful",
      }),
    );
    const envelopes = (await Promise.all(concurrent)) as LodestoneToolResponseV13<FeedbackAck>[];

    for (const env of envelopes) {
      expect(env.results).toHaveLength(1);
      expect(env.results[0]?.ack).toBe(true);
      // Validate no warning leaked from a writer collision.
      const warnings = env.diagnostics.warnings ?? [];
      expect(warnings.some((w) => /writer already open|contention/i.test(w))).toBe(false);
    }

    // Every call must have produced a row; ids must be unique.
    const rows = readAllRows();
    expect(rows).toHaveLength(10);
    const ids = new Set(rows.map((r) => r.id));
    expect(ids.size).toBe(10);
    // request_id linkage must round-trip — load-bearing for v0.5.
    const requestIds = new Set(rows.map((r) => r.request_id));
    expect(requestIds.size).toBe(10);
    for (let i = 0; i < 10; i++) {
      expect(requestIds.has(`concurrent-${i}`)).toBe(true);
    }
  });

  it("subsequent calls reuse the cached writer (no second openWriter)", async () => {
    // After the first call resolves, the cached writer entry is in the §08
    // registry. A direct openWriter on the same path MUST still throw the
    // "writer already open" error — proof that we are NOT closing per call
    // anymore.
    const handler = makeHandler({ cwd: workdir });
    await handler({ tool: "query", request_id: "kept-open-1", signal: "useful" });

    expect(() => openWriter(dbPath)).toThrow(/writer already open/i);

    // The handler can still serve subsequent calls because it owns that entry.
    await handler({ tool: "query", request_id: "kept-open-2", signal: "useful" });
    expect(readAllRows()).toHaveLength(2);
  });
});

describe("handler — fresh-repo bootstrap (no preceding `lodestone init`)", () => {
  it("bootstraps the schema on first feedback call when the DB file is brand new", async () => {
    const fresh = mkdtempSync(path.join(tmpdir(), "lodestone-feedback-fresh-"));
    try {
      const freshDbPath = lodestoneSubpath(fresh, "sqlite");
      expect(existsSync(freshDbPath)).toBe(false);

      const handler = makeHandler({ cwd: fresh });
      const env = (await handler({
        tool: "query",
        request_id: "boot-1",
        signal: "useful",
      })) as LodestoneToolResponseV13<FeedbackAck>;
      expect(env.results[0]?.ack).toBe(true);
      expect(existsSync(freshDbPath)).toBe(true);
    } finally {
      _resetWriterRegistry();
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});

describe("production handler export", () => {
  it("is a callable function", () => {
    expect(typeof productionHandler).toBe("function");
  });
});

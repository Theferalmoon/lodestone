// SPDX-License-Identifier: Apache-2.0
// client/sqlite.ts tests. Validates read-only mode at the driver level + the
// ensureReady wrapper around section 08 assertReady. Uses a temp DB so we don't
// depend on a fixture.
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  openWriter,
  bootstrap,
  closeDb,
  writeReady,
  _resetWriterRegistry,
  writeIndexMeta,
  } from "@lodestone/ingest/store";

import { openReader } from "../client/sqlite.js";

let tmp: string;
let dbPath: string;
let lodestoneDir: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "lodestone-mcp-"));
  lodestoneDir = path.join(tmp, ".lodestone");
  dbPath = path.join(lodestoneDir, "lodestone.sqlite");
  mkdirSync(lodestoneDir, { recursive: true });
  // Bootstrap a real schema so the readonly handle has something to point at.
  const w = openWriter(dbPath);
  bootstrap(w);
  writeIndexMeta(w, 1, { id: "nomic-text-v1.5", dim: 768, quant: "fp32" });
  closeDb(w);
  _resetWriterRegistry();
});

afterEach(() => {
  _resetWriterRegistry();
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

describe("client/sqlite openReader", () => {
  it("opens a readonly handle that survives reads", () => {
    const handle = openReader(dbPath);
    expect(handle.dbPath).toBe(dbPath);
    const row = handle.db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as
      | { v: number | null }
      | undefined;
    expect(row?.v).toBeGreaterThanOrEqual(1);
    handle.close();
  });

  it("rejects write attempts at the driver level (defense-in-depth for sql tool gate)", () => {
    const handle = openReader(dbPath);
    try {
      expect(() => handle.db.exec("CREATE TABLE evil (x INTEGER)")).toThrow();
    } finally {
      handle.close();
    }
  });

  it("ensureReady throws when ready.json is absent", () => {
    const handle = openReader(dbPath);
    try {
      expect(() => handle.ensureReady(lodestoneDir)).toThrow(/not ready/);
    } finally {
      handle.close();
    }
  });

  it("ensureReady returns the marker when ready.json reports ready=true", () => {
    writeReady(lodestoneDir, {
      schema_version: 1,
      lodestone_version: "0.1.0",
      ready: true,
      embedder: { id: "nomic-embed-text-v1.5", dim: 768, quant: "fp32" },
      languages_indexed: ["typescript"],
      indexed_at: new Date().toISOString(),
      commit_at_index: null,
      dirty_at_index: false,
      index_epoch: 1,
      writer_pid: process.pid,
    });
    const handle = openReader(dbPath);
    try {
      const marker = handle.ensureReady(lodestoneDir);
      expect(marker.ready).toBe(true);
      expect(marker.index_epoch).toBe(1);
    } finally {
      handle.close();
    }
  });

  it("ensureReady throws on epoch mismatch", () => {
    writeReady(lodestoneDir, {
      schema_version: 1,
      lodestone_version: "0.1.0",
      ready: true,
      embedder: { id: "nomic-embed-text-v1.5", dim: 768, quant: "fp32" },
      languages_indexed: ["typescript"],
      indexed_at: new Date().toISOString(),
      commit_at_index: null,
      dirty_at_index: false,
      index_epoch: 5,
      writer_pid: process.pid,
    });
    const handle = openReader(dbPath);
    try {
      expect(() => handle.ensureReady(lodestoneDir, 99)).toThrow(/epoch mismatch/);
    } finally {
      handle.close();
    }
  });

  it("close() is idempotent", () => {
    const handle = openReader(dbPath);
    handle.close();
    expect(() => handle.close()).not.toThrow();
  });

  it("openReader on a non-existent path throws a friendly init message", () => {
    expect(() => openReader(path.join(tmp, "nope.sqlite"))).toThrow(/lodestone init/);
  });
});

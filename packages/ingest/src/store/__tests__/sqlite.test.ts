// SPDX-License-Identifier: Apache-2.0
// Tests for sqlite.ts - openWriter / openReader / bootstrap. Real
// better-sqlite3 against a tempdir DB; no mocks.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { CURRENT_SCHEMA_VERSION } from "@lodestone/shared";

import {
  _resetWriterRegistry,
  bootstrap,
  closeDb,
  openReader,
  openWriter,
  readSchemaVersion,
  VECTOR_DIM,
} from "../sqlite.js";

let workdir: string;
let dbPath: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "lodestone-sqlite-test-"));
  dbPath = join(workdir, ".lodestone", "lodestone.sqlite");
});

afterEach(() => {
  _resetWriterRegistry();
  rmSync(workdir, { recursive: true, force: true });
});

describe("openWriter", () => {
  it("creates the DB file (and parent dir) on a fresh path", () => {
    const db = openWriter(dbPath);
    try {
      expect(existsSync(dbPath)).toBe(true);
    } finally {
      closeDb(db);
    }
  });

  it("enables WAL mode (sticky pragma)", () => {
    const db = openWriter(dbPath);
    try {
      const mode = db.pragma("journal_mode", { simple: true });
      expect(mode).toBe("wal");
    } finally {
      closeDb(db);
    }
  });

  it("loads sqlite-vec on the connection (vec_version() resolvable)", () => {
    const db = openWriter(dbPath);
    try {
      const row = db.prepare("SELECT vec_version() AS v").get() as { v: string };
      expect(row.v).toMatch(/^v\d+\.\d+\.\d+/);
    } finally {
      closeDb(db);
    }
  });

  it("VECTOR_DIM is 768 (matches nomic-text-v1.5 embedder)", () => {
    expect(VECTOR_DIM).toBe(768);
  });

  it("throws clearly when called twice in the same process", () => {
    const db = openWriter(dbPath);
    try {
      expect(() => openWriter(dbPath)).toThrow(/writer already open/i);
    } finally {
      closeDb(db);
    }
  });

  it("permits reopen after explicit close", () => {
    const db1 = openWriter(dbPath);
    closeDb(db1);
    const db2 = openWriter(dbPath);
    try {
      expect(db2.open).toBe(true);
    } finally {
      closeDb(db2);
    }
  });
});

describe("openReader", () => {
  it("succeeds when the DB file exists", () => {
    const writer = openWriter(dbPath);
    bootstrap(writer);
    closeDb(writer);
    const reader = openReader(dbPath);
    try {
      expect(reader.readonly).toBe(true);
    } finally {
      closeDb(reader);
    }
  });

  it("throws a friendly error for a missing DB", () => {
    expect(() => openReader(join(workdir, "missing.sqlite"))).toThrow(
      /index not found/i,
    );
  });

  it("loads sqlite-vec on the read-only handle as well", () => {
    const writer = openWriter(dbPath);
    bootstrap(writer);
    closeDb(writer);
    const reader = openReader(dbPath);
    try {
      const row = reader.prepare("SELECT vec_version() AS v").get() as { v: string };
      expect(row.v).toMatch(/^v\d+\.\d+\.\d+/);
    } finally {
      closeDb(reader);
    }
  });

  it("succeeds while a writer is open in the same process", () => {
    const writer = openWriter(dbPath);
    bootstrap(writer);
    const reader = openReader(dbPath);
    try {
      const row = reader
        .prepare("SELECT version FROM schema_version")
        .get() as { version: number };
      expect(row.version).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      closeDb(reader);
      closeDb(writer);
    }
  });

  it("can be opened multiple times concurrently (no readers cap)", () => {
    const writer = openWriter(dbPath);
    bootstrap(writer);
    closeDb(writer);
    const r1 = openReader(dbPath);
    const r2 = openReader(dbPath);
    try {
      expect(r1.open && r2.open).toBe(true);
    } finally {
      closeDb(r1);
      closeDb(r2);
    }
  });
});

describe("bootstrap", () => {
  it("populates schema_version with CURRENT_SCHEMA_VERSION", () => {
    const db = openWriter(dbPath);
    try {
      bootstrap(db);
      expect(readSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      closeDb(db);
    }
  });

  it("creates every canonical table", () => {
    const db = openWriter(dbPath);
    try {
      bootstrap(db);
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all()
        .map((r) => (r as { name: string }).name);
      expect(tables).toEqual(
        expect.arrayContaining([
          "schema_version",
          "symbols",
          "edges",
          "class_inheritance",
          "clusters",
          "cluster_members",
          "skills",
          "feedback",
        ]),
      );
    } finally {
      closeDb(db);
    }
  });

  it("is idempotent - second call is a no-op", () => {
    const db = openWriter(dbPath);
    try {
      bootstrap(db);
      bootstrap(db);
      const count = db
        .prepare("SELECT COUNT(*) AS c FROM schema_version")
        .get() as { c: number };
      expect(count.c).toBe(1);
    } finally {
      closeDb(db);
    }
  });

  it("throws a friendly mismatch error when on-disk version differs", () => {
    const db = openWriter(dbPath);
    try {
      bootstrap(db);
      // Simulate a stale schema by stuffing a fake version row.
      db.prepare("DELETE FROM schema_version").run();
      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(
        99,
        new Date().toISOString(),
      );
      expect(() => bootstrap(db)).toThrow(/schema version mismatch/i);
    } finally {
      closeDb(db);
    }
  });
});

describe("readSchemaVersion", () => {
  it("returns null on an unbootstrapped DB", () => {
    const db = openWriter(dbPath);
    try {
      expect(readSchemaVersion(db)).toBeNull();
    } finally {
      closeDb(db);
    }
  });
});

describe("cross-process read/write concurrency", () => {
  it("a child holding the writer doesn't block reader from main process", () => {
    // Bootstrap first so the schema exists for the child.
    const setup = openWriter(dbPath);
    bootstrap(setup);
    setup
      .prepare(
        "INSERT INTO symbols (id, path, language, kind, range_start_line, range_end_line, updated_at_epoch) VALUES (?,?,?,?,?,?,?)",
      )
      .run("seed", "src/seed.ts", "typescript", "function", 1, 5, 1);
    closeDb(setup);

    // Spawn a child that opens a writer and inserts a row, then exits.
    const childScript = [
      "import('better-sqlite3').then(({ default: Db }) => {",
      `  const db = new Db(${JSON.stringify(dbPath)});`,
      "  db.pragma('journal_mode = WAL');",
      "  db.prepare(\"INSERT INTO symbols (id, path, language, kind, range_start_line, range_end_line, updated_at_epoch) VALUES (?,?,?,?,?,?,?)\").run('child', 'src/child.ts', 'typescript', 'function', 1, 5, 1);",
      "  db.close();",
      "});",
    ].join("\n");
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", childScript], {
      timeout: 5_000,
    });
    expect(child.status).toBe(0);

    // Main-process reader should be able to read consistent post-commit state.
    const reader = openReader(dbPath);
    try {
      const ids = (
        reader.prepare("SELECT id FROM symbols ORDER BY id").all() as Array<{ id: string }>
      ).map((r) => r.id);
      expect(ids).toEqual(["child", "seed"]);
    } finally {
      closeDb(reader);
    }
  }, 15_000);
});

describe("crash recovery (WAL replay)", () => {
  it("uncommitted writes from a killed writer are not visible after reopen", () => {
    const writer = openWriter(dbPath);
    bootstrap(writer);
    writer
      .prepare(
        "INSERT INTO symbols (id, path, language, kind, range_start_line, range_end_line, updated_at_epoch) VALUES (?,?,?,?,?,?,?)",
      )
      .run("committed", "src/c.ts", "typescript", "function", 1, 5, 1);
    // Begin a tx, do writes, then drop the handle without commit.
    writer.prepare("BEGIN").run();
    writer
      .prepare(
        "INSERT INTO symbols (id, path, language, kind, range_start_line, range_end_line, updated_at_epoch) VALUES (?,?,?,?,?,?,?)",
      )
      .run("uncommitted", "src/u.ts", "typescript", "function", 1, 5, 1);
    // Forcibly close without commit. better-sqlite3 closes any open tx as ROLLBACK.
    closeDb(writer);

    const reader = openReader(dbPath);
    try {
      const ids = (
        reader.prepare("SELECT id FROM symbols ORDER BY id").all() as Array<{ id: string }>
      ).map((r) => r.id);
      expect(ids).toEqual(["committed"]);
    } finally {
      closeDb(reader);
    }
  });
});

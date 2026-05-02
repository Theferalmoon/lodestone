// SPDX-License-Identifier: Apache-2.0
// better-sqlite3 wrapper. Owns connection lifecycle, WAL pragma application,
// schema bootstrap, sqlite-vec extension load. Single-writer enforcement is
// in-process only; cross-process write contention is handled by SQLite's
// OS-level lock under WAL semantics.

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CURRENT_SCHEMA_VERSION } from "@lodestone/shared";

/** Vector dimension for the symbol-body embedding column. Matches the
 * Codex-approved nomic-text-v1.5 dim used by section 5's embedder runtime. */
export const VECTOR_DIM = 768;

/** Module-level registry of writer handles, keyed by absolute db path. The
 * entry is set on openWriter and cleared on Database.close. Prevents
 * accidental double-open from the same Node process; cross-process safety
 * is delegated to SQLite's OS lock, not this map. */
const writerRegistry = new Map<string, Database.Database>();

const PRAGMAS = [
  "PRAGMA journal_mode = WAL",
  "PRAGMA synchronous = NORMAL",
  "PRAGMA foreign_keys = ON",
  "PRAGMA temp_store = MEMORY",
  "PRAGMA mmap_size = 268435456",
] as const;

export interface OpenOptions {
  /** When true, sqlite-vec is loaded into the connection. Default: true. */
  loadVec?: boolean;
}

/**
 * Open the SQLite DB in read-write mode with WAL pragmas applied. The parent
 * directory is created if missing. Asserts that no other in-process handle
 * already owns the writer for this path.
 *
 * @throws if a writer is already open in this process for the same path.
 */
export function openWriter(dbPath: string, opts: OpenOptions = {}): Database.Database {
  const existing = writerRegistry.get(dbPath);
  if (existing && existing.open) {
    throw new Error(
      `Lodestone writer already open in this process for ${dbPath}. ` +
        `Close the existing handle first, or open a reader instead.`,
    );
  }

  // Ensure parent dir exists for fresh DBs. better-sqlite3 will create the
  // file but not the directory.
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  applyPragmas(db);
  if (opts.loadVec !== false) {
    loadVectorExtension(db);
  }

  // Wrap close so we can drop the registry entry; preserve return type.
  const originalClose = db.close.bind(db);
  db.close = (() => {
    writerRegistry.delete(dbPath);
    return originalClose();
  }) as typeof db.close;

  writerRegistry.set(dbPath, db);
  return db;
}

/**
 * Open the SQLite DB in read-only mode. Always succeeds when the file exists,
 * even if a writer is currently open in this or another process.
 *
 * @throws if the DB file does not exist (with a friendly hint about
 *   `lodestone init`). This is the section 13 MCP-server-facing reader.
 */
export function openReader(dbPath: string, opts: OpenOptions = {}): Database.Database {
  if (!existsSync(dbPath)) {
    throw new Error(
      `Lodestone index not found at ${dbPath}. Run \`lodestone init\` first.`,
    );
  }
  // fileMustExist mirrors the explicit check above; readonly disables write SQL.
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  applyPragmas(db, { readOnly: true });
  if (opts.loadVec !== false) {
    loadVectorExtension(db);
  }
  return db;
}

/**
 * Apply the canonical schema (migrations/001-initial.sql) inside a single
 * transaction, then record the current schema version. Idempotent.
 *
 * @throws if the on-disk schema_version exists but doesn't match
 *   CURRENT_SCHEMA_VERSION; directs the user to `lodestone reindex --reset`.
 */
export function bootstrap(db: Database.Database): void {
  const onDisk = readSchemaVersion(db);
  if (onDisk === CURRENT_SCHEMA_VERSION) {
    return;
  }
  if (onDisk !== null && onDisk !== CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Lodestone schema version mismatch: on-disk=${onDisk}, expected=${CURRENT_SCHEMA_VERSION}. ` +
        `Run \`lodestone reindex --reset\` to rebuild the index.`,
    );
  }

  const sql = loadInitialSchemaSql();
  // Apply schema and stamp version atomically so a partial schema apply leaves
  // no half-built tables. The INSERT must be prepared AFTER the schema runs,
  // because better-sqlite3 validates table existence at prepare time.
  const tx = db.transaction(() => {
    db.exec(sql);
    db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(
      CURRENT_SCHEMA_VERSION,
      new Date().toISOString(),
    );
  });
  tx();
}

/**
 * Returns the highest schema version recorded in the DB, or null if the
 * schema_version table doesn't exist yet (uninitialized DB).
 */
export function readSchemaVersion(db: Database.Database): number | null {
  const exists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'",
    )
    .get() as { name: string } | undefined;
  if (!exists) return null;
  const row = db
    .prepare("SELECT MAX(version) AS v FROM schema_version")
    .get() as { v: number | null } | undefined;
  return row?.v ?? null;
}

/**
 * Close the DB and drop the in-process writer entry, if any. Safe to call on
 * a reader handle (in which case it just closes).
 */
export function closeDb(db: Database.Database): void {
  if (db.open) db.close();
}

/** Test/maintenance helper - clear all in-process writer registry entries.
 * Not for production use; tests call this in afterEach. */
export function _resetWriterRegistry(): void {
  for (const db of writerRegistry.values()) {
    if (db.open) db.close();
  }
  writerRegistry.clear();
}

function applyPragmas(db: Database.Database, opts: { readOnly?: boolean } = {}): void {
  // journal_mode=WAL is sticky on the DB file once set by any writer; readers
  // still benefit from issuing the pragma (no-op if already WAL). All other
  // pragmas are per-connection and must be set on every handle.
  for (const p of PRAGMAS) {
    if (opts.readOnly && p.startsWith("PRAGMA journal_mode")) {
      // journal_mode requires a write to advance; skip on read-only handles.
      continue;
    }
    db.pragma(p.replace(/^PRAGMA\s+/, ""));
  }
}

function loadVectorExtension(db: Database.Database): void {
  // sqlite-vec ships a prebuilt platform-specific shared library; the helper
  // resolves the right binary for the current Node platform.
  sqliteVec.load(db);
}

function loadInitialSchemaSql(): string {
  // Resolve path relative to this compiled module so the schema file ships
  // next to the .js after tsc build (src/store/migrations -> dist/store/migrations).
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "migrations", "001-initial.sql"),
    // src tree (vitest runs against src/, not dist/).
    join(here, "..", "..", "src", "store", "migrations", "001-initial.sql"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return readFileSync(c, "utf8");
  }
  throw new Error(
    `Lodestone initial schema SQL not found. Looked at: ${candidates.join(", ")}`,
  );
}

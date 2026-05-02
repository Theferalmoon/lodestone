// SPDX-License-Identifier: Apache-2.0
// Read-only SQLite client wrapper for the MCP server. Wraps openReader from
// @lodestone/ingest/store/sqlite (which already opens better-sqlite3 in
// readonly mode) and pairs it with assertReady so every request can verify
// the index is consistent before serving data.
//
// POST-CODEX-001: KuzuDB is GONE. This file replaces the previously-spec'd
// `client/kuzu.ts`. The SQLite reader is the only graph/relational handle the
// MCP server uses; LanceDB stays out of scope for §13 (it's a §14 query-tool
// concern).

import {
  openReader as openSqliteReader,
  assertReady,
  type ReadyMarker,
} from "@lodestone/ingest/store";

/**
 * Underlying readonly SQLite connection type. Inferred from @lodestone/ingest's
 * openReader return value so this package doesn't need a direct dep on
 * `better-sqlite3` types — keeps the MCP-server module graph lean.
 */
export type SqliteReadonlyDb = ReturnType<typeof openSqliteReader>;

export interface ReaderHandle {
  /** The underlying readonly better-sqlite3 connection. */
  db: SqliteReadonlyDb;
  /** Absolute path of the SQLite file the handle was opened against. */
  dbPath: string;
  /**
   * Verify the index is ready BEFORE serving a tool request. Throws when
   * `ready.json` is missing/false or the optional `expectedEpoch` doesn't
   * match. server.ts catches and returns the standard "not_ready" envelope.
   */
  ensureReady(lodestoneDir: string, expectedEpoch?: number): ReadyMarker;
  /** Close the handle. Idempotent. */
  close(): void;
}

/**
 * Open a read-only handle to the project SQLite index. The file MUST exist —
 * `lodestone init` writes it on first run; the helper from @lodestone/ingest
 * throws a friendly error otherwise.
 */
export function openReader(dbPath: string): ReaderHandle {
  const db = openSqliteReader(dbPath);
  let closed = false;
  return {
    db,
    dbPath,
    ensureReady: (lodestoneDir: string, expectedEpoch?: number) =>
      assertReady(lodestoneDir, expectedEpoch),
    close(): void {
      if (closed) return;
      closed = true;
      if (db.open) db.close();
    },
  };
}

-- SPDX-License-Identifier: Apache-2.0
-- Migration 002 — index_meta + epoch oracle.
--
-- Why: Codex impl-008 review caught three load-bearing storage gaps:
--   1. ready.json.index_epoch was the sole oracle for index freshness, with
--      no way to detect when SQLite committed an epoch but ready.json failed
--      to rename (crash window). Add an in-DB authoritative epoch the reader
--      can cross-check against ready.json.
--   2. writeEmbeddings hard-coded VECTOR_DIM=768, which crashes any pipeline
--      using the 384-dim snowflake fallback embedder. Storage must record
--      the embedder identity at index time and fail fast on dim mismatch.
--   3. Repeated reindex with upsert-only writes accumulates orphans. The
--      current_epoch row + a per-table index_epoch filter lets us issue a
--      single delete-everything-from-prior-epochs sweep at the start of a
--      reindex transaction.
--
-- Singleton pattern: id INTEGER PRIMARY KEY CHECK (id = 1) — exactly one
-- row. Bootstrap runs INSERT OR IGNORE with id=1 so first-run is automatic;
-- later writes use UPSERT.
--
-- Compliance: NIST 800-53 SI-7 (Software & Information Integrity — atomic
-- epoch oracle), CM-6 (Configuration Settings — embedder identity
-- persisted), AU-2 (Audit Events — updated_at on every epoch bump);
-- CMMC L2 SI.L2-3.14.1; SOC 2 CC7.2; ISO 27001 A.12.1.2; FedRAMP Mod SI-7;
-- CIS v8 Control 4.

CREATE TABLE index_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  -- Highest committed index_epoch. Readers compare against
  -- ready.json.index_epoch to detect a "ready.json says epoch N but DB only
  -- got to N-1" crash window.
  current_epoch INTEGER NOT NULL DEFAULT 0,
  -- Embedder identity captured at the most recent successful index pass.
  -- writeEmbeddings consults embedder_dim before persisting any vector — a
  -- mismatch throws a fail-fast error rather than silently corrupting the
  -- vec0 table.
  embedder_id TEXT,
  embedder_dim INTEGER,
  embedder_quant TEXT,
  -- ISO-8601 of the last update; useful for diagnostics surfaces.
  updated_at TEXT NOT NULL
);

-- Bootstrap the singleton row so callers can always UPSERT rather than
-- INSERT-vs-UPDATE.
INSERT OR IGNORE INTO index_meta (id, current_epoch, updated_at)
VALUES (1, 0, '1970-01-01T00:00:00Z');

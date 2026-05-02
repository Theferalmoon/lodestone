-- SPDX-License-Identifier: Apache-2.0
-- Lodestone canonical schema, version 1. Single source of truth per
-- claude-plan.md §1.3 (POST-CODEX-001 amendment) and section-08 spec.
--
-- DDL order intentionally creates referenced tables before referrers so
-- foreign-key constraints resolve cleanly at write time. SQLite parses
-- FK declarations lazily (target table need not exist at CREATE), but
-- creating dependencies first keeps the ordering self-evident.
--
-- Pragmas (journal_mode, synchronous, foreign_keys, temp_store, mmap_size)
-- are applied programmatically by sqlite.ts on every connection - they
-- belong in code so they survive across migrations and across reader vs
-- writer handles.

CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE clusters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_status TEXT NOT NULL,
  description TEXT,
  description_embedding BLOB,
  size INTEGER NOT NULL,
  algorithm TEXT NOT NULL,
  algorithm_version TEXT NOT NULL,
  modularity REAL,
  index_epoch INTEGER NOT NULL
);

CREATE TABLE symbols (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  language TEXT NOT NULL,
  kind TEXT NOT NULL,
  range_start_line INTEGER NOT NULL,
  range_end_line INTEGER NOT NULL,
  signature TEXT,
  docstring TEXT,
  pagerank REAL,
  cluster_id TEXT REFERENCES clusters(id) ON DELETE SET NULL,
  updated_at_commit TEXT,
  updated_at_epoch INTEGER NOT NULL
);
CREATE INDEX idx_symbols_path ON symbols(path);
CREATE INDEX idx_symbols_cluster ON symbols(cluster_id);
CREATE INDEX idx_symbols_pagerank ON symbols(pagerank DESC);

CREATE TABLE edges (
  from_id TEXT NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  to_id TEXT NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (from_id, to_id, kind)
);
CREATE INDEX idx_edges_to ON edges(to_id);

CREATE TABLE class_inheritance (
  class_id TEXT PRIMARY KEY REFERENCES symbols(id) ON DELETE CASCADE,
  base_name TEXT NOT NULL,
  base_path TEXT
);
CREATE INDEX idx_inheritance_base ON class_inheritance(base_name);

CREATE TABLE cluster_members (
  cluster_id TEXT NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
  symbol_id TEXT NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  is_bridge INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (cluster_id, symbol_id)
);
CREATE INDEX idx_cluster_members_symbol ON cluster_members(symbol_id);

CREATE TABLE skills (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  description_embedding BLOB,
  body TEXT NOT NULL,
  source_cluster_id TEXT REFERENCES clusters(id) ON DELETE SET NULL,
  maturity TEXT NOT NULL,
  confidence REAL NOT NULL,
  evidence_count INTEGER NOT NULL,
  observed_days INTEGER NOT NULL,
  emitted_at TEXT NOT NULL,
  expires_at TEXT,
  body_sha256 TEXT NOT NULL
);

CREATE TABLE feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recorded_at TEXT NOT NULL,
  tool TEXT NOT NULL,
  request_id TEXT NOT NULL,
  signal TEXT NOT NULL,
  note TEXT
);

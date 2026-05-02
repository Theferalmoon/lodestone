-- SPDX-License-Identifier: Apache-2.0
-- Migration 003 — class_inheritance composite primary key.
--
-- §08 YELLOW (Codex impl-008): the original schema used
--   PRIMARY KEY (class_id)
-- which collapsed every (class_id, base_name) triple onto the *last* row
-- emitted by the parser. Languages with multiple inheritance / multiple
-- interfaces (TypeScript `extends X implements Y, Z`, Python `class C(A,
-- B):`, etc.) silently lost every base after the first.
--
-- Section 11 (seed-skills error-hierarchy detector) reads multiple triples
-- per class to reconstruct the error chain. It currently consumes the
-- in-memory parser output to dodge this storage hole; this migration closes
-- the hole at the storage layer so any future consumer (graph queries,
-- impact analysis, custom SQL via the `sql` tool) sees the full triple set.
--
-- Compliance: NIST 800-53 SI-7 (Software & Information Integrity), CM-6
-- (Configuration Settings); CMMC L2 SI.L2-3.14.1; SOC 2 CC7.2;
-- ISO 27001 A.12.1.2; FedRAMP Mod SI-7; CIS v8 Control 4.

-- SQLite cannot ALTER a primary key in place — we recreate the table.
-- v0 indexes are tiny (parsers produce O(1) bases per class), so the
-- copy is fast.

CREATE TABLE class_inheritance__new (
  class_id TEXT NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  base_name TEXT NOT NULL,
  base_path TEXT,
  PRIMARY KEY (class_id, base_name)
);

INSERT INTO class_inheritance__new (class_id, base_name, base_path)
SELECT class_id, base_name, base_path FROM class_inheritance;

DROP TABLE class_inheritance;
ALTER TABLE class_inheritance__new RENAME TO class_inheritance;

CREATE INDEX idx_inheritance_base ON class_inheritance(base_name);

// SPDX-License-Identifier: Apache-2.0
// Authoritative cross-store epoch + embedder identity oracle.
//
// Codex impl-008 review caught three load-bearing storage gaps that all
// resolve to "the on-disk SQLite has no single source of truth that other
// stores (ready.json, vec0 table, on-disk SKILL files) can cross-check
// against." This module owns the §08 fix.
//
// Reads are cheap (one row, one prepared statement); writes happen at the
// epoch boundary inside `beginReindex` + as a final UPDATE inside the same
// transaction that bumps `current_epoch`. A reader that wants the canonical
// epoch calls `getCurrentEpoch(db)`; a reader that wants the canonical
// embedder identity calls `getEmbedderIdentity(db)`.
//
// Compliance: NIST 800-53 SI-7 (Software & Information Integrity — atomic
// epoch oracle), CM-6 (Configuration Settings), AU-2 (Audit Events);
// CMMC L2 SI.L2-3.14.1; SOC 2 CC7.2; ISO 27001 A.12.1.2; FedRAMP Mod SI-7;
// CIS v8 Control 4.

import type Database from "better-sqlite3";

import type { IndexMetaRow } from "@lodestone/shared";

/** Embedder identity slice — what `index_meta` records and what
 * `writeEmbeddings` validates incoming vectors against. */
export interface EmbedderIdentity {
  id: string;
  dim: number;
  quant: string;
}

/**
 * Read the singleton `index_meta` row. Returns `null` only on databases that
 * predate migration 002 (i.e. legacy v0.1.0 indexes); after `bootstrap()`
 * runs, the row is guaranteed to exist with `current_epoch = 0` and NULL
 * embedder fields.
 *
 * Fail-soft on a missing table so legacy callers (tests, the §13 e2e harness
 * with a hand-rolled DB) keep working — they will simply observe `null`.
 */
export function readIndexMeta(db: Database.Database): IndexMetaRow | null {
  const tableExists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='index_meta'",
    )
    .get() as { name: string } | undefined;
  if (!tableExists) return null;
  const row = db
    .prepare(
      "SELECT id, current_epoch, embedder_id, embedder_dim, embedder_quant, updated_at FROM index_meta WHERE id = 1",
    )
    .get() as IndexMetaRow | undefined;
  return row ?? null;
}

/**
 * Read the authoritative current epoch. Returns 0 when no index pass has
 * committed yet (fresh bootstrap) OR when the DB predates migration 002 —
 * either way, "no epoch on disk" is the right answer for cross-checking.
 */
export function getCurrentEpoch(db: Database.Database): number {
  const meta = readIndexMeta(db);
  return meta?.current_epoch ?? 0;
}

/**
 * Read the authoritative embedder identity. Returns `null` when no index
 * pass has stamped it yet; callers that need an identity for a fail-fast
 * dim check should treat `null` as "no identity → fall back to legacy
 * VECTOR_DIM constant."
 */
export function getEmbedderIdentity(db: Database.Database): EmbedderIdentity | null {
  const meta = readIndexMeta(db);
  if (!meta) return null;
  if (
    meta.embedder_id === null ||
    meta.embedder_dim === null ||
    meta.embedder_quant === null
  ) {
    return null;
  }
  return {
    id: meta.embedder_id,
    dim: meta.embedder_dim,
    quant: meta.embedder_quant,
  };
}

/**
 * Persist a fresh epoch + embedder identity. Caller MUST run this inside a
 * transaction (typically the same tx that wrote symbols/edges/embeddings) so
 * the epoch bump is atomic with the data it describes.
 */
export function writeIndexMeta(
  db: Database.Database,
  epoch: number,
  embedder: EmbedderIdentity,
  now: () => string = () => new Date().toISOString(),
): void {
  db.prepare(
    `INSERT INTO index_meta (id, current_epoch, embedder_id, embedder_dim, embedder_quant, updated_at)
     VALUES (1, @epoch, @id, @dim, @quant, @updated_at)
     ON CONFLICT(id) DO UPDATE SET
       current_epoch = excluded.current_epoch,
       embedder_id = excluded.embedder_id,
       embedder_dim = excluded.embedder_dim,
       embedder_quant = excluded.embedder_quant,
       updated_at = excluded.updated_at`,
  ).run({
    epoch,
    id: embedder.id,
    dim: embedder.dim,
    quant: embedder.quant,
    updated_at: now(),
  });
}

/** Tables wiped by `beginReindex`. Order matters: child rows before parents
 * (FKs would cascade for free, but explicit DELETEs make the SQL self-
 * evident and survive any future migration that disables CASCADE). */
const REINDEX_WIPE_TABLES = [
  "cluster_members",
  "class_inheritance",
  "edges",
  "skills",
  "symbols",
  "clusters",
] as const;

/**
 * Atomically:
 *   1. Bump `current_epoch` to `prior + 1` (allocates a fresh epoch number
 *      that no prior pass used).
 *   2. Wipe every per-pass row from prior epochs — symbols, edges,
 *      class_inheritance, clusters, cluster_members, skills, and the vec0
 *      `symbol_embeddings` virtual table — so the new pass writes into a
 *      truly empty table set. impl-008 RED #2 fix: upsert-only writes cannot
 *      detect deleted symbols, and edge weights doubled on every reindex.
 *   3. Persist the embedder identity used by this pass (RED #3 — readers need
 *      to know the dim before serving any vector lane).
 *
 * Returns the freshly-allocated epoch. Caller passes it to every downstream
 * `writeSymbols / writeClusters / writeReady` call so they all stamp the same
 * epoch.
 *
 * The whole sequence runs inside ONE transaction so a crash mid-wipe leaves
 * the DB on the prior epoch (consistent) instead of "wiped but new pass never
 * wrote" (empty + lying ready.json).
 *
 * Caller MUST NOT have any prior open transaction on `db` — better-sqlite3
 * forbids nested transactions.
 */
export function beginReindex(
  db: Database.Database,
  embedder: EmbedderIdentity,
  options: { now?: () => string } = {},
): number {
  const now = options.now ?? (() => new Date().toISOString());

  let allocated = 0;
  const tx = db.transaction(() => {
    const meta = readIndexMeta(db);
    const prior = meta?.current_epoch ?? 0;
    allocated = prior + 1;

    for (const table of REINDEX_WIPE_TABLES) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
    const hasVec0 = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type IN ('table','virtual') AND name='symbol_embeddings'",
      )
      .get() as { name: string } | undefined;
    if (hasVec0) {
      db.prepare("DELETE FROM symbol_embeddings").run();
    }

    writeIndexMeta(db, allocated, embedder, now);
  });
  tx();
  return allocated;
}

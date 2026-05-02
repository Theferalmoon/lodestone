// SPDX-License-Identifier: Apache-2.0
// Persist Cluster + members to the §08 SQLite store. Idempotent: ON CONFLICT
// updates so re-running the same input yields the same DB state.

import type Database from "better-sqlite3";

import type { Cluster } from "@lodestone/shared";

import type { EmbedderHandle } from "../embed/runtime.js";

export interface PersistOptions {
  index_epoch: number;
  algorithm: string;
  algorithm_version: string;
  /**
   * Optional embedder. When supplied, `cluster.description` is embedded and
   * stored in `clusters.description_embedding` (BLOB) so §16 `cluster()`'s
   * semantic-fallback lane has data to match against. When omitted the
   * column is left NULL — backwards-compat with callers (and tests) that
   * don't have an embedder available at persist time.
   */
  embedder?: EmbedderHandle;
}

/**
 * Insert/update clusters + their member rows. Wraps everything in a single
 * transaction so a failure mid-batch leaves the DB in a coherent state.
 *
 * If `opts.embedder` is provided, each cluster's `description` is embedded
 * in a single batched call and the resulting Float32Array is persisted as a
 * BLOB in `clusters.description_embedding`. If absent, the column is NULL
 * (matches the pre-v0.1.1 behavior — `skills_for`/`cluster()` semantic
 * lanes degrade to substring/LIKE fallback).
 */
export async function persistClusters(
  db: Database.Database,
  clusters: readonly Cluster[],
  opts: PersistOptions,
): Promise<{ clustersWritten: number; membersWritten: number }> {
  // Backfill description embeddings up-front (single batched embedder call,
  // outside the transaction so we don't hold a write lock during inference).
  let embeddings: (Buffer | null)[] = clusters.map(() => null);
  if (opts.embedder && clusters.length > 0) {
    const texts = clusters.map((c) => c.description ?? "");
    const vectors = await opts.embedder.embed(texts);
    embeddings = vectors.map((vec) =>
      vec ? Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength) : null,
    );
  }

  const insertCluster = db.prepare(
    `INSERT INTO clusters (
       id, name, name_status, description, description_embedding,
       size, algorithm, algorithm_version, modularity, index_epoch
     ) VALUES (
       @id, @name, @name_status, @description, @description_embedding,
       @size, @algorithm, @algorithm_version, @modularity, @index_epoch
     )
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       name_status = excluded.name_status,
       description = excluded.description,
       description_embedding = excluded.description_embedding,
       size = excluded.size,
       algorithm = excluded.algorithm,
       algorithm_version = excluded.algorithm_version,
       modularity = excluded.modularity,
       index_epoch = excluded.index_epoch`,
  );

  const deleteMembers = db.prepare(
    `DELETE FROM cluster_members WHERE cluster_id = @cluster_id`,
  );
  const insertMember = db.prepare(
    `INSERT INTO cluster_members (cluster_id, symbol_id, is_bridge)
     VALUES (@cluster_id, @symbol_id, @is_bridge)
     ON CONFLICT(cluster_id, symbol_id) DO UPDATE SET is_bridge = excluded.is_bridge`,
  );

  let clustersWritten = 0;
  let membersWritten = 0;

  const tx = db.transaction((batch: readonly Cluster[]) => {
    for (let i = 0; i < batch.length; i++) {
      const c = batch[i]!;
      insertCluster.run({
        id: c.id,
        name: c.name,
        name_status: c.name_status,
        description: c.description ?? null,
        description_embedding: embeddings[i] ?? null,
        size: c.size,
        algorithm: opts.algorithm,
        algorithm_version: opts.algorithm_version,
        modularity: c.diagnostics.modularity,
        index_epoch: opts.index_epoch,
      });
      clustersWritten++;

      // Replace member set for this cluster (handles symbols moving between clusters).
      deleteMembers.run({ cluster_id: c.id });
      const bridgeIds = new Set(c.bridges.map((b) => b.symbol));
      for (const m of c.members) {
        insertMember.run({
          cluster_id: c.id,
          symbol_id: m.symbol,
          is_bridge: bridgeIds.has(m.symbol) ? 1 : 0,
        });
        membersWritten++;
      }
    }
  });
  tx(clusters);
  return { clustersWritten, membersWritten };
}

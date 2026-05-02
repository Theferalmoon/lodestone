// SPDX-License-Identifier: Apache-2.0
// Persist Cluster + members to the §08 SQLite store. Idempotent: ON CONFLICT
// updates so re-running the same input yields the same DB state.

import type Database from "better-sqlite3";

import type { Cluster } from "@lodestone/shared";

export interface PersistOptions {
  index_epoch: number;
  algorithm: string;
  algorithm_version: string;
}

/**
 * Insert/update clusters + their member rows. Wraps everything in a single
 * transaction so a failure mid-batch leaves the DB in a coherent state.
 *
 * description_embedding is left NULL — the §10 skill emitter or a future
 * embedder pass will backfill it.
 */
export function persistClusters(
  db: Database.Database,
  clusters: readonly Cluster[],
  opts: PersistOptions,
): { clustersWritten: number; membersWritten: number } {
  const insertCluster = db.prepare(
    `INSERT INTO clusters (
       id, name, name_status, description, description_embedding,
       size, algorithm, algorithm_version, modularity, index_epoch
     ) VALUES (
       @id, @name, @name_status, @description, NULL,
       @size, @algorithm, @algorithm_version, @modularity, @index_epoch
     )
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       name_status = excluded.name_status,
       description = excluded.description,
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
    for (const c of batch) {
      insertCluster.run({
        id: c.id,
        name: c.name,
        name_status: c.name_status,
        description: c.description ?? null,
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

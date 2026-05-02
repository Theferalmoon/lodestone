// SPDX-License-Identifier: Apache-2.0
// Typed read-side query helpers. Section 13 MCP server consumes openReader()
// from sqlite.ts and the helpers here for vector search, edge traversal,
// callers/callees, impact, and cluster membership.

import type Database from "better-sqlite3";

import type { EdgeRow, SymbolRow } from "@lodestone/shared";

import { getEmbedderIdentity } from "./index-meta.js";
import { VECTOR_DIM, vecLoadError } from "./sqlite.js";
import {
  CALLEES_OF_SQL,
  CALLERS_OF_SQL,
  CLUSTER_MEMBERS_SQL,
  IMPACT_OF_SQL,
} from "./queries.js";

/** A vector search hit - symbol + cosine distance (smaller is closer). */
export interface VectorHit {
  symbol_id: string;
  distance: number;
}

/** A row from a callers/callees recursive CTE. */
export interface ReachabilityHit {
  id: string;
  path: string;
  range_start_line: number;
  range_end_line: number;
  pagerank: number | null;
  depth: number;
}

/** Look up a single symbol by id. Returns null when absent. */
export function getSymbol(db: Database.Database, id: string): SymbolRow | null {
  const row = db.prepare("SELECT * FROM symbols WHERE id = ?").get(id) as
    | SymbolRow
    | undefined;
  return row ?? null;
}

/** All edges where to_id matches (callers / dependents). */
export function getInboundEdges(db: Database.Database, toId: string): EdgeRow[] {
  return db
    .prepare("SELECT * FROM edges WHERE to_id = ?")
    .all(toId) as EdgeRow[];
}

/** All edges where from_id matches (callees / dependencies). */
export function getOutboundEdges(db: Database.Database, fromId: string): EdgeRow[] {
  return db
    .prepare("SELECT * FROM edges WHERE from_id = ?")
    .all(fromId) as EdgeRow[];
}

/**
 * Recursive caller traversal up to maxDepth. Returns reachable callers
 * ordered by pagerank desc, capped at limit.
 */
export function callersOf(
  db: Database.Database,
  symbolId: string,
  maxDepth = 3,
  limit = 50,
): ReachabilityHit[] {
  return db
    .prepare(CALLERS_OF_SQL)
    .all({ symbol_id: symbolId, max_depth: maxDepth, limit }) as ReachabilityHit[];
}

/** Recursive callee traversal up to maxDepth. */
export function calleesOf(
  db: Database.Database,
  symbolId: string,
  maxDepth = 3,
  limit = 50,
): ReachabilityHit[] {
  return db
    .prepare(CALLEES_OF_SQL)
    .all({ symbol_id: symbolId, max_depth: maxDepth, limit }) as ReachabilityHit[];
}

/**
 * Impact = total transitive callers (blast radius) up to maxDepth. Returns
 * the same shape as callersOf with depth populated for each reached node.
 */
export function impactOf(
  db: Database.Database,
  symbolId: string,
  maxDepth = 5,
  limit = 200,
): ReachabilityHit[] {
  return db
    .prepare(IMPACT_OF_SQL)
    .all({ symbol_id: symbolId, max_depth: maxDepth, limit }) as ReachabilityHit[];
}

/** Members of a cluster, ordered by pagerank desc. */
export function clusterMembers(
  db: Database.Database,
  clusterId: string,
  limit = 100,
): ReachabilityHit[] {
  return db
    .prepare(CLUSTER_MEMBERS_SQL)
    .all({ cluster_id: clusterId, limit }) as ReachabilityHit[];
}

/**
 * Cosine search over the symbol_embeddings vec0 table. Returns the topK
 * nearest hits; raises a clear error if the query vector dimension does
 * not match the active embedder dim.
 *
 * Active dim = `index_meta.embedder_dim` when an ingest pass has stamped
 * one, else the legacy `VECTOR_DIM` constant. Read-side half of the impl-008
 * RED #3 fixup: a 384-dim query against a 768-dim store (or vice versa)
 * fails fast with a readable error instead of silently returning empty.
 */
export function vectorSearch(
  db: Database.Database,
  queryVector: Float32Array,
  topK = 10,
): VectorHit[] {
  // §08 YELLOW (sqlite-vec degrade): when the extension didn\'t load on this
  // platform, return empty hits instead of letting `embedding MATCH` raise
  // "no such function". Lexical lanes (LIKE / SQL) keep working.
  if (vecLoadError(db) !== null) return [];
  const expectedDim = getEmbedderIdentity(db)?.dim ?? VECTOR_DIM;
  if (queryVector.length !== expectedDim) {
    throw new Error(
      `Query vector has length ${queryVector.length}, expected ${expectedDim}.`,
    );
  }
  const buf = Buffer.from(
    queryVector.buffer,
    queryVector.byteOffset,
    queryVector.byteLength,
  );
  const rows = db
    .prepare(
      `SELECT symbol_id, distance
         FROM symbol_embeddings
        WHERE embedding MATCH ?
          AND k = ?
        ORDER BY distance`,
    )
    .all(buf, topK) as VectorHit[];
  return rows;
}

// SPDX-License-Identifier: Apache-2.0
// Reusable SQL recursive CTE definitions used by reader.ts and section 15
// MCP graph tools. Centralized so impact / callers / callees stay consistent
// across call sites.

/**
 * CALLERS_OF_SQL - reachable callers up to :max_depth, ordered by callee
 * symbol pagerank desc, capped at :limit. Edge kind is `calls`.
 */
export const CALLERS_OF_SQL = `
WITH RECURSIVE callers(id, depth) AS (
  SELECT from_id AS id, 1 AS depth
    FROM edges
   WHERE to_id = :symbol_id AND kind = 'calls'
  UNION
  SELECT e.from_id, c.depth + 1
    FROM edges e
    JOIN callers c ON e.to_id = c.id
   WHERE e.kind = 'calls' AND c.depth < :max_depth
)
SELECT s.id, s.path, s.range_start_line, s.range_end_line, s.pagerank, MIN(c.depth) AS depth
  FROM callers c
  JOIN symbols s ON s.id = c.id
 GROUP BY s.id, s.path, s.range_start_line, s.range_end_line, s.pagerank
 ORDER BY s.pagerank DESC NULLS LAST, s.id ASC
 LIMIT :limit
`;

/**
 * CALLEES_OF_SQL - reachable callees up to :max_depth, ordered by pagerank
 * desc, capped at :limit. Mirror of CALLERS_OF_SQL.
 */
export const CALLEES_OF_SQL = `
WITH RECURSIVE callees(id, depth) AS (
  SELECT to_id AS id, 1 AS depth
    FROM edges
   WHERE from_id = :symbol_id AND kind = 'calls'
  UNION
  SELECT e.to_id, c.depth + 1
    FROM edges e
    JOIN callees c ON e.from_id = c.id
   WHERE e.kind = 'calls' AND c.depth < :max_depth
)
SELECT s.id, s.path, s.range_start_line, s.range_end_line, s.pagerank, MIN(c.depth) AS depth
  FROM callees c
  JOIN symbols s ON s.id = c.id
 GROUP BY s.id, s.path, s.range_start_line, s.range_end_line, s.pagerank
 ORDER BY s.pagerank DESC NULLS LAST, s.id ASC
 LIMIT :limit
`;

/**
 * IMPACT_OF_SQL - blast-radius variant of CALLERS_OF_SQL with a wider default
 * depth. Same shape so reader code can treat them uniformly.
 */
export const IMPACT_OF_SQL = CALLERS_OF_SQL;

/**
 * CLUSTER_MEMBERS_SQL - members of a cluster ordered by pagerank desc.
 */
export const CLUSTER_MEMBERS_SQL = `
SELECT s.id, s.path, s.range_start_line, s.range_end_line, s.pagerank, 0 AS depth
  FROM cluster_members m
  JOIN symbols s ON s.id = m.symbol_id
 WHERE m.cluster_id = :cluster_id
 ORDER BY s.pagerank DESC NULLS LAST, s.id ASC
 LIMIT :limit
`;

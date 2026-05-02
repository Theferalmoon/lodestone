// SPDX-License-Identifier: Apache-2.0
// `sql` tool — §15 implementation. Read-only escape-hatch query against the
// project's SQLite Lodestone index. POST-CODEX-001: this is the renamed
// `cypher` tool. Three layers of defense, all required:
//
//   1. Registry-time gate (§13 buildActiveRegistry): tool is NOT registered
//      unless `[mcp].dangerous_tools_enabled = true` AND `expose` lists it.
//   2. Handler-entry re-check via env override `LODESTONE_DANGEROUS_TOOLS`.
//      Defense-in-depth — even if a bug in the registry path lets `sql`
//      register without the gate, this check rejects at call time.
//   3. Driver-level OPEN_READONLY (better-sqlite3 readonly:true). DDL/DML
//      raise inside the driver and we surface a structured error.
//
// Compliance: NIST 800-53 AC-3 (Access Enforcement — read-only handle),
// AC-6 (Least Privilege — multi-layer gate), AU-2 (Audit Events — every call
// carries a request_id), SC-28 (Protection at Rest); CMMC L2 AC.L2-3.1.5;
// SOC 2 CC6.1, CC7.2; ISO 27001 A.9.4.1, A.18.1.3; FedRAMP Mod AC-3, AC-6;
// CIS v8 Control 6.8 (least privilege), DAIV (data-at-rest defense in depth).
import { z } from "zod";

import {
  LODESTONE_CHANNEL_V0,
  wrapErr,
  wrapNotReady,
  wrapOk,
  type LodestoneToolResponseV13,
} from "../envelope.js";
import { assertReady, openProjectReader, toMcpInputSchema } from "./_shared.js";

export const description =
  "Execute an arbitrary SQL query against the project's read-only Lodestone SQLite index. Returns rows as JSON. DANGEROUS: only registered when `[mcp].dangerous_tools_enabled = true`. The connection is opened readonly at the driver level so write attempts (INSERT, UPDATE, DELETE, DROP) throw — but the operator should still treat exposing this tool as a power-user feature, not a default. Use for ad-hoc graph traversals beyond the canned `query` / `context` / `impact` / `cluster` tools, or for debugging the index itself.";

export const inputSchema = z.object({
  query: z.string().min(1, "query must be non-empty"),
  channel: z.literal("code").optional(),
});

export type SqlInput = z.infer<typeof inputSchema>;

/** Pre-computed JSON-Schema-7 view of `inputSchema` for the MCP `tools/list`
 * surface. Pre-compute at module load — see `toMcpInputSchema` JSDoc. */
export const jsonSchema = toMcpInputSchema(inputSchema);

export const dangerous = true;

/** §15 amendment: row cap and query-string-length cap. */
const MAX_ROWS = 1000;
const MAX_QUERY_BYTES = 4096;

/**
 * §15 RED #2 — DoS-preflight maximum number of `SCAN` operations that may
 * appear in an EXPLAIN QUERY PLAN. Each `SCAN` over a table without an index
 * is effectively a full table walk; chaining multiple scans from one
 * statement (the cartesian-product smell) is what we reject. SQLite's
 * planner emits one `SCAN` per cartesian arm, so >=3 scans means a join
 * surface big enough to wedge the synchronous query path.
 *
 * Note: `better-sqlite3` does not expose a JS binding for
 * `sqlite3_interrupt`, so we cannot abort a query mid-flight from a
 * setTimeout callback (the SQL call blocks the Node event loop). The
 * realistic defense is preflight rejection here + bounded materialization
 * via stmt.iterate() in the executor below.
 */
const MAX_PLAN_SCANS = 2;

/** Output row shape — every column is the better-sqlite3 raw JS value. */
type SqlRow = Record<string, unknown>;

export async function handler(
  input: unknown,
): Promise<LodestoneToolResponseV13<SqlRow>> {
  // Defense-in-depth gate: even though buildActiveRegistry refuses to
  // register `sql` without the flag, the handler also re-checks an env
  // override. The env override is set explicitly by the §13 main entrypoint
  // when reading the parsed config — purely belt-and-suspenders.
  if (!dangerousToolsEnabled()) {
    return wrapErr<SqlRow>(
      "sql tool disabled: [mcp].dangerous_tools_enabled is false",
      LODESTONE_CHANNEL_V0,
    );
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return wrapErr<SqlRow>(
      `invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      LODESTONE_CHANNEL_V0,
    );
  }

  const { query } = parsed.data;
  if (Buffer.byteLength(query, "utf8") > MAX_QUERY_BYTES) {
    return wrapErr<SqlRow>(
      `query exceeds ${MAX_QUERY_BYTES} byte cap (defense-in-depth)`,
      LODESTONE_CHANNEL_V0,
    );
  }

  // §15 RED #2: statement-shape gate. Strip leading whitespace + comments,
  // then require the first keyword to be SELECT or WITH and the body to
  // contain exactly one statement. better-sqlite3's prepare() will accept
  // anything that parses; PRAGMA, ATTACH, ANALYZE, and friends are all
  // technically read-side but expand the attack surface. We pin the gate to
  // SELECT/WITH (the only shapes the spec calls out for ad-hoc graph
  // traversal).
  const shapeError = checkStatementShape(query);
  if (shapeError !== null) {
    return wrapErr<SqlRow>(shapeError, LODESTONE_CHANNEL_V0);
  }

  let handle: ReturnType<typeof openProjectReader>;
  try {
    handle = openProjectReader();
  } catch (err) {
    return wrapErr<SqlRow>(
      `index unavailable: ${(err as Error).message}`,
      LODESTONE_CHANNEL_V0,
    );
  }

  try {
    // impl-008 RED #4 cross-cut.
    try {
      assertReady(handle);
    } catch {
      return wrapNotReady<SqlRow>(LODESTONE_CHANNEL_V0);
    }

    // §15 RED #2: EXPLAIN QUERY PLAN preflight. Reject queries whose plan
    // shows back-to-back full-table SCANs (the cartesian-product / cross-
    // join smell). EXPLAIN itself runs the planner, not the query, and is
    // bounded — even on a pathological input it returns near-instant.
    const planError = preflightPlan(handle.db, query);
    if (planError !== null) {
      return wrapErr<SqlRow>(planError, LODESTONE_CHANNEL_V0);
    }

    let stmt: ReturnType<typeof handle.db.prepare<[]>>;
    try {
      stmt = handle.db.prepare<[]>(query);
    } catch (err) {
      // Parse-time error (malformed SQL) — surface as a structured warning.
      return wrapErr<SqlRow>(
        `parse-error: ${(err as Error).message}`,
        LODESTONE_CHANNEL_V0,
      );
    }

    let rows: SqlRow[];
    let truncated = false;
    try {
      // .reader is true for SELECT-style statements; better-sqlite3 surfaces
      // it as a runtime property after prepare(). DDL/DML statements raise
      // at the driver layer thanks to OPEN_READONLY — caught below.
      if (stmt.reader === false) {
        rows = [];
        try {
          stmt.run();
        } catch (err) {
          return wrapErr<SqlRow>(
            `read-only-violation: ${(err as Error).message}`,
            LODESTONE_CHANNEL_V0,
          );
        }
      } else {
        // §15 RED #2: stream rows via iterate() and stop at MAX_ROWS+1 so
        // a query that would have produced 10 million rows does not
        // materialize them all in memory before the post-truncate slice.
        // The iterator yields synchronously inside the C++ binding, so
        // this still occupies the event loop while the query runs — but
        // it bounds RAM, which is what protects the process.
        rows = [];
        const iter = stmt.iterate() as IterableIterator<SqlRow>;
        try {
          for (const row of iter) {
            if (rows.length >= MAX_ROWS) {
              truncated = true;
              break;
            }
            rows.push(row);
          }
        } finally {
          // Releasing the statement handle / closing the iterator is best
          // effort; better-sqlite3 cleans up on stmt.finalize() at GC time
          // but explicit return helps determinism.
          if (typeof iter.return === "function") {
            try {
              iter.return();
            } catch {
              /* noop */
            }
          }
        }
      }
    } catch (err) {
      return wrapErr<SqlRow>(
        `read-only-violation: ${(err as Error).message}`,
        LODESTONE_CHANNEL_V0,
      );
    }

    const env = wrapOk<SqlRow>(rows, LODESTONE_CHANNEL_V0);
    if (truncated) {
      env.truncated = true;
      env.diagnostics = {
        ...env.diagnostics,
        warnings: [
          ...(env.diagnostics.warnings ?? []),
          `result-set truncated to ${MAX_ROWS} rows`,
        ],
      };
    }
    return env;
  } finally {
    handle.close();
  }
}

/**
 * Strip leading SQL whitespace + `--` line comments + `/* ... *\/` block
 * comments and return the remainder, lower-cased and trimmed. Returns the
 * empty string when the query body is comment-only.
 *
 * Used by the statement-shape gate to find the "first keyword" without
 * being fooled by a leading comment.
 */
function stripLeadingNoise(raw: string): string {
  let i = 0;
  const n = raw.length;
  while (i < n) {
    const ch = raw[i];
    // ASCII whitespace
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }
    // -- line comment
    if (ch === "-" && raw[i + 1] === "-") {
      while (i < n && raw[i] !== "\n") i++;
      continue;
    }
    // /* block comment */
    if (ch === "/" && raw[i + 1] === "*") {
      i += 2;
      while (i < n && !(raw[i] === "*" && raw[i + 1] === "/")) i++;
      if (i < n) i += 2;
      continue;
    }
    break;
  }
  return raw.slice(i);
}

/**
 * §15 RED #2 statement-shape gate. Returns a structured warning string when
 * the query is not a single SELECT/WITH read query, else null.
 *
 * Single-statement check is a heuristic — we look for a `;` followed by
 * any non-whitespace, non-comment character. Trailing `;` is allowed.
 */
function checkStatementShape(raw: string): string | null {
  const stripped = stripLeadingNoise(raw);
  const lower = stripped.toLowerCase();
  if (!/^(select|with)\b/.test(lower)) {
    return "statement-shape: query must begin with SELECT or WITH (read-only escape hatch)";
  }
  // Multi-statement detection. SQLite's planner only runs the first
  // statement that better-sqlite3 prepares, so the practical risk of
  // multi-statement queries is limited; rejecting them is still cleaner
  // because operators expect one statement = one result set.
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;
  let i = 0;
  const n = raw.length;
  let sawTerminator = false;
  while (i < n) {
    const ch = raw[i];
    const next = raw[i + 1];
    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      i++;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (inSingle) {
      if (ch === "'" && next === "'") {
        i += 2;
        continue;
      }
      if (ch === "'") inSingle = false;
      i++;
      continue;
    }
    if (inDouble) {
      if (ch === '"' && next === '"') {
        i += 2;
        continue;
      }
      if (ch === '"') inDouble = false;
      i++;
      continue;
    }
    if (ch === "-" && next === "-") {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 2;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      i++;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      i++;
      continue;
    }
    if (ch === ";") {
      sawTerminator = true;
      i++;
      continue;
    }
    if (sawTerminator && ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") {
      return "multi-statement: query must contain a single statement";
    }
    i++;
  }
  return null;
}

/** Row shape returned by `EXPLAIN QUERY PLAN`. */
interface PlanRow {
  id: number;
  parent: number;
  notused: number;
  detail: string;
}

/**
 * §15 RED #2 EXPLAIN QUERY PLAN preflight. Returns a structured warning
 * when the planner's output looks pathological (cartesian product / too
 * many full-table SCANs in one statement), else null.
 *
 * Rationale: better-sqlite3 is synchronous and exposes no interrupt JS
 * binding, so once `stmt.all()` / `stmt.iterate().next()` enters native
 * code we cannot stop it. The cheap defense is to refuse to run plans
 * whose dominant cost driver is "scan everything" before the executor
 * gets a chance to wedge the event loop.
 *
 * `EXPLAIN QUERY PLAN` itself runs the planner only (no row materialization)
 * and returns near-instant even for pathological inputs.
 */
function preflightPlan(
  db: ReturnType<typeof openProjectReader>["db"],
  query: string,
): string | null {
  let plan: PlanRow[];
  try {
    plan = db.prepare(`EXPLAIN QUERY PLAN ${query}`).all() as PlanRow[];
  } catch {
    // If EXPLAIN itself fails we let the executor surface a structured
    // parse-error / read-only-violation downstream.
    return null;
  }
  let scanCount = 0;
  for (const row of plan) {
    // SQLite emits "SCAN <table>" or "SCAN CONSTANT ROW" depending on the
    // shape; we only count real-table scans (the cartesian smell).
    if (/^SCAN\s+(?!CONSTANT)/i.test(row.detail)) {
      scanCount++;
    }
  }
  if (scanCount > MAX_PLAN_SCANS) {
    return `cartesian/cost: EXPLAIN QUERY PLAN shows ${scanCount} full-table SCANs (limit ${MAX_PLAN_SCANS}); add a WHERE-clause join filter or restrict the FROM list`;
  }
  return null;
}

/**
 * Read the dangerous-tools flag from env. Defaults to false (closed). The §13
 * server entrypoint sets `LODESTONE_DANGEROUS_TOOLS=1` when its parsed config
 * has `dangerous_tools_enabled: true`. Tests set the env directly.
 */
function dangerousToolsEnabled(): boolean {
  const v = process.env.LODESTONE_DANGEROUS_TOOLS;
  if (!v) return false;
  return v === "1" || v.toLowerCase() === "true";
}

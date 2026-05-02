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
  wrapOk,
  type LodestoneToolResponseV13,
} from "../envelope.js";
import { openProjectReader, toMcpInputSchema } from "./_shared.js";

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
        rows = stmt.all() as SqlRow[];
      }
    } catch (err) {
      return wrapErr<SqlRow>(
        `read-only-violation: ${(err as Error).message}`,
        LODESTONE_CHANNEL_V0,
      );
    }

    let truncated = false;
    if (rows.length > MAX_ROWS) {
      rows = rows.slice(0, MAX_ROWS);
      truncated = true;
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
 * Read the dangerous-tools flag from env. Defaults to false (closed). The §13
 * server entrypoint sets `LODESTONE_DANGEROUS_TOOLS=1` when its parsed config
 * has `dangerous_tools_enabled: true`. Tests set the env directly.
 */
function dangerousToolsEnabled(): boolean {
  const v = process.env.LODESTONE_DANGEROUS_TOOLS;
  if (!v) return false;
  return v === "1" || v.toLowerCase() === "true";
}

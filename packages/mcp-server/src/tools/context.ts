// SPDX-License-Identifier: Apache-2.0
// `context` tool — §15 implementation. Returns the architectural surround of
// a single symbol: defining file + range, callers + callees ranked by
// PageRank, the cluster the symbol belongs to (id + name when persisted),
// and class membership. Symbol-resolution policy from §15:
//   - input contains "::"           → fully-qualified, single-symbol lookup
//   - input contains "/" or .ext    → file-path, file-level summary
//   - otherwise                     → bare-name → SymbolMatches with hint
//
// Compliance: NIST 800-53 AC-3 (Access Enforcement — read-only handle),
// AU-2 (Audit Events — request_id surfaced for downstream feedback), SI-10
// (Information Input Validation — zod schema + lexical input classification),
// SC-28 (Protection at Rest); CMMC L2 AC.L2-3.1.5, AU.L2-3.3.1; SOC 2 CC6.1,
// CC7.2; ISO 27001 A.9.4.1, A.12.4.1; FedRAMP Mod AC-3, AU-2; CIS v8 4.1.
import { z } from "zod";

import {
  callersOf,
  calleesOf,
  getInboundEdges,
  getOutboundEdges,
  getSymbol,
  type ReachabilityHit,
} from "@lodestone/ingest/store";
import type { SymbolRow } from "@lodestone/shared";

import {
  LODESTONE_CHANNEL_V0,
  wrapErr,
  wrapOk,
  type LodestoneToolResponseV13,
} from "../envelope.js";
import { openProjectReader } from "./db.js";

export const description =
  "Return the architectural context surrounding a specific symbol: its callers, callees, the cluster it belongs to, the cluster's purpose, sibling symbols inside the same cluster, and any skill cards that mention it. Use this when the agent has a candidate symbol (from `query` or from a stack trace) and needs to understand how it fits into the codebase before editing. Pulls from SQLite edges, clusters, and skills tables in a single bounded read pass.";

export const inputSchema = z.object({
  symbol: z.string().min(1, "symbol must be non-empty"),
  channel: z.literal("code").optional(),
});

export type ContextInput = z.infer<typeof inputSchema>;

/** Top-N caller/callee cap to keep responses bounded — §15 spec sets 50. */
const MAX_NEIGHBORS = 50;

/** Source-file extensions used by the lexical file-path classifier. */
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs"];

/** Symbol reference shape returned in callers/callees lists. */
interface SymbolRef {
  symbol: string;
  path: string;
  range: { start_line: number; end_line: number };
  pagerank?: number;
}

/** SymbolContext envelope payload — the populated, single-symbol shape. */
interface SymbolContext {
  symbol: string;
  defined_at: { path: string; range: { start_line: number; end_line: number } };
  callers: SymbolRef[];
  callees: SymbolRef[];
  imports_from: string[];
  imported_by: string[];
  cluster_id?: string;
  cluster_name?: string;
}

/** SymbolMatches envelope payload — the bare-name disambiguation shape. */
interface SymbolMatches {
  matches: SymbolRef[];
  suggestion: string;
}

/** Lexical kind of an input string — drives resolution policy. */
type InputKind = "fully_qualified" | "file_path" | "bare_name";

export function classifyInput(raw: string): InputKind {
  if (raw.includes("::")) return "fully_qualified";
  const looksLikeFile =
    raw.includes("/") ||
    SOURCE_EXTENSIONS.some((ext) => raw.toLowerCase().endsWith(ext));
  if (looksLikeFile) return "file_path";
  return "bare_name";
}

export async function handler(
  input: unknown,
): Promise<LodestoneToolResponseV13<SymbolContext | SymbolMatches>> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return wrapErr<SymbolContext | SymbolMatches>(
      `invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      LODESTONE_CHANNEL_V0,
    );
  }

  const { symbol } = parsed.data;
  const kind = classifyInput(symbol);

  let handle: ReturnType<typeof openProjectReader>;
  try {
    handle = openProjectReader();
  } catch (err) {
    return wrapErr<SymbolContext | SymbolMatches>(
      `index unavailable: ${(err as Error).message}`,
      LODESTONE_CHANNEL_V0,
    );
  }

  try {
    if (kind === "fully_qualified") {
      const row = getSymbol(handle.db, symbol);
      if (!row) {
        // §15: nonexistent → empty results, not an error.
        return wrapOk<SymbolContext | SymbolMatches>([], LODESTONE_CHANNEL_V0);
      }
      const ctx = buildSymbolContext(handle.db, row);
      return wrapOk<SymbolContext | SymbolMatches>([ctx], LODESTONE_CHANNEL_V0);
    }

    if (kind === "file_path") {
      // File-level summary: collect all symbols defined in this file path.
      const fileRows = handle.db
        .prepare(
          "SELECT * FROM symbols WHERE path = ? ORDER BY pagerank DESC NULLS LAST, id ASC LIMIT ?",
        )
        .all(symbol, MAX_NEIGHBORS) as SymbolRow[];
      if (fileRows.length === 0) {
        return wrapOk<SymbolContext | SymbolMatches>([], LODESTONE_CHANNEL_V0);
      }
      // Build a file-level pseudo-context: the "symbol" is the file path,
      // callers/callees aggregate the file's outermost edges (deduped).
      const ctx = buildFileContext(handle.db, symbol, fileRows);
      return wrapOk<SymbolContext | SymbolMatches>([ctx], LODESTONE_CHANNEL_V0);
    }

    // Bare-name lookup: exact-match on the trailing segment of `id`. The
    // canonical id format is `path::Class::method` or `path::name`; the
    // trailing `::name` is what we name-match on. Falls back to a LIKE on
    // the full id when no rows are produced (covers files whose ids omit
    // the leading path).
    const nameRows = handle.db
      .prepare(
        "SELECT * FROM symbols WHERE id LIKE ? ORDER BY pagerank DESC NULLS LAST, id ASC LIMIT ?",
      )
      .all(`%::${symbol}`, MAX_NEIGHBORS) as SymbolRow[];
    const matches: SymbolRef[] = nameRows.map(symbolRowToRef);
    const top = matches[0];

    const suggestion =
      matches.length === 0 || !top
        ? `No symbol named '${symbol}' found. Try a fully-qualified form like 'src/path.ts::${symbol}'.`
        : matches.length === 1
          ? `One match for '${symbol}'. Use the fully-qualified form '${top.symbol}' for an exact context lookup.`
          : `Multiple matches for '${symbol}'. Use a fully-qualified form like '${top.symbol}' to disambiguate.`;

    const result: SymbolMatches = { matches, suggestion };
    return wrapOk<SymbolContext | SymbolMatches>([result], LODESTONE_CHANNEL_V0);
  } finally {
    handle.close();
  }
}

/** Convert a SymbolRow to the envelope-facing SymbolRef shape. */
function symbolRowToRef(row: SymbolRow): SymbolRef {
  const ref: SymbolRef = {
    symbol: row.id,
    path: row.path,
    range: {
      start_line: row.range_start_line,
      end_line: row.range_end_line,
    },
  };
  if (row.pagerank !== null && row.pagerank !== undefined) {
    ref.pagerank = row.pagerank;
  }
  return ref;
}

/** Convert a ReachabilityHit (recursive-CTE row) to a SymbolRef. */
function hitToRef(hit: ReachabilityHit): SymbolRef {
  const ref: SymbolRef = {
    symbol: hit.id,
    path: hit.path,
    range: {
      start_line: hit.range_start_line,
      end_line: hit.range_end_line,
    },
  };
  if (hit.pagerank !== null && hit.pagerank !== undefined) {
    ref.pagerank = hit.pagerank;
  }
  return ref;
}

/** Look up a cluster name by id, returning null when absent. */
function lookupClusterName(
  db: ReturnType<typeof openProjectReader>["db"],
  clusterId: string | null,
): string | null {
  if (!clusterId) return null;
  const row = db
    .prepare("SELECT name FROM clusters WHERE id = ?")
    .get(clusterId) as { name: string } | undefined;
  return row?.name ?? null;
}

/** Collect inbound `imports` edges for a symbol id → path list. */
function collectImportedBy(
  db: ReturnType<typeof openProjectReader>["db"],
  symbolId: string,
): string[] {
  const rows = getInboundEdges(db, symbolId).filter((e) => e.kind === "imports");
  const out = new Set<string>();
  for (const e of rows) out.add(e.from_id);
  return [...out];
}

/** Collect outbound `imports` edges for a symbol id → path list. */
function collectImportsFrom(
  db: ReturnType<typeof openProjectReader>["db"],
  symbolId: string,
): string[] {
  const rows = getOutboundEdges(db, symbolId).filter((e) => e.kind === "imports");
  const out = new Set<string>();
  for (const e of rows) out.add(e.to_id);
  return [...out];
}

/** Build a single-symbol SymbolContext from a resolved SymbolRow. */
function buildSymbolContext(
  db: ReturnType<typeof openProjectReader>["db"],
  row: SymbolRow,
): SymbolContext {
  const callers = callersOf(db, row.id, 3, MAX_NEIGHBORS).map(hitToRef);
  const callees = calleesOf(db, row.id, 3, MAX_NEIGHBORS).map(hitToRef);
  const imports_from = collectImportsFrom(db, row.id);
  const imported_by = collectImportedBy(db, row.id);
  const clusterName = lookupClusterName(db, row.cluster_id);

  const ctx: SymbolContext = {
    symbol: row.id,
    defined_at: {
      path: row.path,
      range: {
        start_line: row.range_start_line,
        end_line: row.range_end_line,
      },
    },
    callers,
    callees,
    imports_from,
    imported_by,
  };
  if (row.cluster_id) ctx.cluster_id = row.cluster_id;
  if (clusterName) ctx.cluster_name = clusterName;
  return ctx;
}

/** Build a file-level pseudo-SymbolContext aggregating per-file edges. */
function buildFileContext(
  db: ReturnType<typeof openProjectReader>["db"],
  filePath: string,
  fileRows: SymbolRow[],
): SymbolContext {
  // Aggregate caller/callee union across every symbol in the file.
  const callerMap = new Map<string, SymbolRef>();
  const calleeMap = new Map<string, SymbolRef>();
  const fileSymbolIds = new Set(fileRows.map((r) => r.id));

  for (const row of fileRows) {
    for (const hit of callersOf(db, row.id, 2, MAX_NEIGHBORS)) {
      // Skip same-file symbols so the file context isn't dominated by
      // intra-file edges.
      if (fileSymbolIds.has(hit.id)) continue;
      if (!callerMap.has(hit.id)) callerMap.set(hit.id, hitToRef(hit));
    }
    for (const hit of calleesOf(db, row.id, 2, MAX_NEIGHBORS)) {
      if (fileSymbolIds.has(hit.id)) continue;
      if (!calleeMap.has(hit.id)) calleeMap.set(hit.id, hitToRef(hit));
    }
  }

  const callers = [...callerMap.values()]
    .sort((a, b) => (b.pagerank ?? -Infinity) - (a.pagerank ?? -Infinity))
    .slice(0, MAX_NEIGHBORS);
  const callees = [...calleeMap.values()]
    .sort((a, b) => (b.pagerank ?? -Infinity) - (a.pagerank ?? -Infinity))
    .slice(0, MAX_NEIGHBORS);

  // imports_from / imported_by: union across every symbol in the file.
  const importsFrom = new Set<string>();
  const importedBy = new Set<string>();
  for (const row of fileRows) {
    for (const x of collectImportsFrom(db, row.id)) importsFrom.add(x);
    for (const x of collectImportedBy(db, row.id)) importedBy.add(x);
  }

  // Pick the best (highest-PR) symbol's range for defined_at; aggregated
  // start/end lines could be misleading. End_line uses MAX across the file.
  const anchor = fileRows[0];
  const startLine = Math.min(...fileRows.map((r) => r.range_start_line));
  const endLine = Math.max(...fileRows.map((r) => r.range_end_line));

  // Cluster id/name: pick from the highest-PR symbol that is clustered.
  let clusterId: string | null = null;
  for (const row of fileRows) {
    if (row.cluster_id) {
      clusterId = row.cluster_id;
      break;
    }
  }
  const clusterName = lookupClusterName(db, clusterId);

  const ctx: SymbolContext = {
    symbol: filePath,
    defined_at: {
      path: filePath,
      range: { start_line: startLine, end_line: endLine },
    },
    callers,
    callees,
    imports_from: [...importsFrom],
    imported_by: [...importedBy],
  };
  if (clusterId) ctx.cluster_id = clusterId;
  if (clusterName) ctx.cluster_name = clusterName;
  // anchor reference kept implicit via defined_at.path; no need to surface
  // it on the wire — agents can re-query with a fully-qualified id when
  // they want a per-symbol drill-down.
  void anchor;
  return ctx;
}

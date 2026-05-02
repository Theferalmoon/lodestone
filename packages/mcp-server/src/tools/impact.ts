// SPDX-License-Identifier: Apache-2.0
// `impact` tool — §15 implementation. Reverse-reachability blast-radius for
// a file or fully-qualified symbol, ranked by PageRank descending. Backed by
// IMPACT_OF_SQL (recursive CTE in §08 queries.ts). When the input is a file
// path the tool expands to every symbol defined in that file and unions
// their blast radii (deduped). Cap at 100 results — §13's truncation layer
// is the safety net; this cap is the polite first line.
//
// Compliance: NIST 800-53 AC-3 (Access Enforcement — read-only handle),
// AU-2 (Audit Events — request_id surfaced for downstream feedback),
// SI-10 (Information Input Validation — zod + lexical input classification),
// SC-28 (Protection at Rest); CMMC L2 AC.L2-3.1.5; SOC 2 CC6.1, CC7.2;
// ISO 27001 A.9.4.1; FedRAMP Mod AC-3, AU-2; CIS v8 4.1.
import { z } from "zod";

import { impactOf, type ReachabilityHit } from "@lodestone/ingest/store";
import type { SymbolRow } from "@lodestone/shared";

import {
  LODESTONE_CHANNEL_V0,
  wrapErr,
  wrapNotReady,
  wrapOk,
  type LodestoneToolResponseV13,
} from "../envelope.js";
import { assertReady, openProjectReader, toMcpInputSchema } from "./_shared.js";

export const description =
  "Return the reverse-reachability set for a file or symbol: all callers, all transitive importers, the clusters they live in, and a rough blast-radius score. Use this BEFORE editing a function to understand what might break, or AFTER seeing a test fail to find related call sites. Backed by a recursive CTE over the SQLite `edges` table — bounded by depth and result count to keep response size sane.";

export const inputSchema = z.object({
  file_or_symbol: z.string().min(1, "file_or_symbol must be non-empty"),
  channel: z.literal("code").optional(),
});

export type ImpactInput = z.infer<typeof inputSchema>;

/** Pre-computed JSON-Schema-7 view of `inputSchema` for the MCP `tools/list`
 * surface. Pre-compute at module load — see `toMcpInputSchema` JSDoc. */
export const jsonSchema = toMcpInputSchema(inputSchema);

/** Polite cap; §15 spec sets 100. §13 truncate.ts is the hard safety net. */
const MAX_IMPACT_RESULTS = 100;
/** Recursion depth cap for the IMPACT_OF_SQL CTE. */
const IMPACT_DEPTH = 5;

/** SymbolRef shape returned in shortest_path entries. */
interface SymbolRef {
  symbol: string;
  path: string;
  range: { start_line: number; end_line: number };
  pagerank?: number;
}

/** Per-impacted-node payload — matches the §15 spec's ImpactNode shape.
 *
 * §15 YELLOW (Codex impl-015): `shortest_path` is a v0 one-step approximation
 * (`[origin, impacted]`) regardless of true depth, because the IMPACT_OF_SQL
 * recursive CTE doesn't carry parent links. `blast_radius` is set to the
 * CTE's per-id depth, not a real breadth/count radius. We surface both
 * caveats so callers can detect them:
 *
 *   - `path_kind: "exact"` when blast_radius === 1 (the path IS the direct
 *     edge), `"approximate"` otherwise.
 *   - `approximate: true` mirror of the same signal for callers that prefer
 *     a boolean flag.
 *   - top-level `diagnostics.warnings` entry the first time a response
 *     contains any approximate path, so the agent gets a single visible
 *     hint per call rather than per row.
 */
interface ImpactNode {
  symbol: SymbolRef;
  blast_radius: number;
  pagerank: number;
  shortest_path: SymbolRef[];
  /** "exact" when the path is the literal direct caller edge (blast_radius === 1),
   *  else "approximate" — the CTE doesn't carry parent links in v0. */
  path_kind: "exact" | "approximate";
  /** Boolean mirror of `path_kind === "approximate"`; surfaced for callers
   *  that prefer a flag over a string discriminator. Omitted when false to
   *  keep the wire payload small for the common direct-caller case. */
  approximate?: true;
}

export async function handler(
  input: unknown,
): Promise<LodestoneToolResponseV13<ImpactNode>> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return wrapErr<ImpactNode>(
      `invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      LODESTONE_CHANNEL_V0,
    );
  }

  const { file_or_symbol } = parsed.data;

  let handle: ReturnType<typeof openProjectReader>;
  try {
    handle = openProjectReader();
  } catch (err) {
    return wrapErr<ImpactNode>(
      `index unavailable: ${(err as Error).message}`,
      LODESTONE_CHANNEL_V0,
    );
  }

  try {
    // impl-008 RED #4 cross-cut.
    try {
      assertReady(handle);
    } catch {
      return wrapNotReady<ImpactNode>(LODESTONE_CHANNEL_V0);
    }

    const startingIds = resolveStartingSymbols(handle.db, file_or_symbol);
    if (startingIds.length === 0) {
      return wrapOk<ImpactNode>([], LODESTONE_CHANNEL_V0);
    }

    // Collect impacted hits across every starting symbol. Per-impacted-node
    // shortest_path is a one-step approximation — full BFS path tracing
    // would require the recursive CTE to emit the parent chain (out of
    // scope for v0). v0 surfaces the depth and the originating starting
    // symbol; agents can re-query callersOf for a deeper trace.
    const startingRefs = new Map<string, SymbolRef>();
    for (const id of startingIds) {
      const row = handle.db
        .prepare("SELECT * FROM symbols WHERE id = ?")
        .get(id) as SymbolRow | undefined;
      if (row) startingRefs.set(id, symbolRowToRef(row));
    }

    const aggregated = new Map<
      string,
      { hit: ReachabilityHit; origin: string; depth: number }
    >();
    for (const startId of startingIds) {
      const hits = impactOf(
        handle.db,
        startId,
        IMPACT_DEPTH,
        MAX_IMPACT_RESULTS,
      );
      for (const hit of hits) {
        // Skip self-edges and starting-set members (impact ≠ identity).
        if (startingIds.includes(hit.id)) continue;
        const existing = aggregated.get(hit.id);
        if (!existing || hit.depth < existing.depth) {
          aggregated.set(hit.id, {
            hit,
            origin: startId,
            depth: hit.depth,
          });
        }
      }
    }

    // Each row's blast_radius approximates "how many other things would also
    // need re-examining if this node is touched" — use the per-id depth as a
    // proxy: shallower = larger radius. v0 surfaces depth as a tie-breaker
    // and uses pagerank as the primary sort.
    const nodes: ImpactNode[] = [...aggregated.values()].map(
      ({ hit, origin, depth }) => {
        const ref = hitToRef(hit);
        const startRef = startingRefs.get(origin);
        const shortestPath: SymbolRef[] = startRef
          ? [startRef, ref]
          : [ref];
        // §15 YELLOW: depth=1 means the impacted node is a direct caller of
        // the origin, so `[origin, impacted]` IS the literal shortest path.
        // depth>1 means we're surfacing an indirect caller and the same
        // two-element list is a one-step approximation — flag it so the
        // caller doesn't treat the path as ground truth.
        const isExact = depth === 1;
        const node: ImpactNode = {
          symbol: ref,
          blast_radius: depth,
          pagerank: hit.pagerank ?? 0,
          shortest_path: shortestPath,
          path_kind: isExact ? "exact" : "approximate",
        };
        if (!isExact) node.approximate = true;
        return node;
      },
    );

    nodes.sort((a, b) => {
      const pr = b.pagerank - a.pagerank;
      if (pr !== 0) return pr;
      return a.symbol.symbol.localeCompare(b.symbol.symbol);
    });

    const capped = nodes.slice(0, MAX_IMPACT_RESULTS);
    const env = wrapOk<ImpactNode>(capped, LODESTONE_CHANNEL_V0);
    // §15 YELLOW: emit a single top-level approximation-disclosure warning
    // when ANY result row carries an approximate path. One warning per call
    // keeps the diagnostics envelope readable while still surfacing the
    // caveat to the agent. Omitted when every result is depth=1 (the
    // file-path-expansion fast path that returns only direct callers).
    if (capped.some((n) => n.path_kind === "approximate")) {
      env.diagnostics = {
        ...env.diagnostics,
        warnings: [
          ...(env.diagnostics.warnings ?? []),
          "approximate: shortest_path entries with blast_radius>1 are a one-step approximation (v0 CTE does not carry parent links); treat path_kind=='approximate' rows as 'reachable from origin within blast_radius hops' rather than the literal call chain",
        ],
      };
    }
    return env;
  } finally {
    handle.close();
  }
}

/**
 * Resolve the input to one or more starting symbol ids:
 *   - "::" present → exact lookup, single-element list (or empty when absent)
 *   - otherwise treat as path → expand to every symbol in that file
 */
function resolveStartingSymbols(
  db: ReturnType<typeof openProjectReader>["db"],
  raw: string,
): string[] {
  if (raw.includes("::")) {
    const row = db
      .prepare("SELECT id FROM symbols WHERE id = ?")
      .get(raw) as { id: string } | undefined;
    return row ? [row.id] : [];
  }
  // File-path expansion.
  const rows = db
    .prepare("SELECT id FROM symbols WHERE path = ? ORDER BY id ASC")
    .all(raw) as Array<{ id: string }>;
  return rows.map((r) => r.id);
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

/** Convert a SymbolRow to a SymbolRef. */
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

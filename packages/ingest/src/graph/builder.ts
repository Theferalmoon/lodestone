// SPDX-License-Identifier: Apache-2.0
// Graph builder — union per-file parser output into a single directed
// graphology Graph for downstream PageRank (§07), persistence (§08), and
// Louvain clustering (§09).
//
// Node key: `LodestoneSymbol.symbol` (canonical fully-qualified id).
// Node attrs: `{ symbol, external }` — `symbol` is the original record;
// `external` is true for stub nodes added for unresolved edge targets.
// Edge attrs: `{ kind, weight }`. Weight aggregates when the same
// (source, target, kind) triple appears more than once.

// graphology ships as CJS with named exports. Under NodeNext ESM at runtime,
// `import { MultiDirectedGraph } from "graphology"` fails. Use namespace
// import + .default access, mirroring graph/pagerank.ts's pattern. Types
// come from a sibling type-only import so the generic parameters still work.
import * as graphologyModule from "graphology";
import type { MultiDirectedGraph as MultiDirectedGraphCls } from "graphology";
import type { Edge, EdgeKind, LodestoneSymbol } from "@lodestone/shared";

// At runtime, the namespace's `default` is the graphology module object that
// holds Graph, MultiDirectedGraph, etc. (CJS interop). Fall back to the
// namespace itself if the bundler already unwrapped it.
const graphology = (
  (graphologyModule as unknown as { default?: typeof graphologyModule }).default ?? graphologyModule
) as typeof graphologyModule;
const MultiDirectedGraphCtor = graphology.MultiDirectedGraph as unknown as typeof MultiDirectedGraphCls;

/** Attributes on every node in the built graph. */
export interface GraphNodeAttributes {
  /** Original symbol record; `null` for stub external nodes. */
  symbol: LodestoneSymbol | null;
  /** True when the node was synthesized from an unresolved edge target. */
  external: boolean;
}

/** Attributes on every edge in the built graph. */
export interface GraphEdgeAttributes {
  kind: EdgeKind;
  /** Aggregated count when the same (from, to, kind) appeared multiple times. */
  weight: number;
}

/** Public alias so consumers don't need to import `graphology` to spell the type. */
export type LodestoneGraph = MultiDirectedGraphCls<GraphNodeAttributes, GraphEdgeAttributes>;

export interface BuildGraphInput {
  symbols: readonly LodestoneSymbol[];
  edges: readonly Edge[];
}

export interface BuildGraphOptions {
  /**
   * When true, synthesize stub `external: true` nodes for edge endpoints
   * that aren't in the symbol set (legacy behaviour). When false (the
   * default), drop those edges entirely so the public surface only ever
   * contains internal symbols. (YELLOW §07 fix per Codex impl-007-result:
   * direct callers of `buildGraph` were leaking external package names
   * like "lodash" into PageRank rankings; the production pipeline already
   * filtered to resolved-only edges, but the public API surface needs to
   * match that default.)
   *
   * Use `true` only when you specifically want adjacency completeness for
   * a centrality measure that needs un-pruned out-degree on internal
   * nodes — currently nothing in production does.
   */
  includeExternalStubs?: boolean;
}

/**
 * Build a directed graphology Graph from the union of all parsers' output.
 *
 * Behaviour:
 *   - One node per `LodestoneSymbol` keyed by `symbol.symbol`.
 *   - Edges to a target id that isn't in the symbol set are dropped by
 *     default (YELLOW §07 fix). Pass `includeExternalStubs: true` to get
 *     the legacy behaviour where unresolved targets become stub nodes
 *     with `{ external: true, symbol: null }`.
 *   - Self-loops are accepted (recursive functions exist).
 *   - Repeated `(from, to, kind)` triples increment `weight` rather than
 *     adding a parallel edge. The single-edge model fits a `DirectedGraph`
 *     (vs `MultiDirectedGraph`) and matches the §08 SQLite EdgeRow model
 *     which keys on `(from_id, to_id, kind)` with a single `weight` column.
 *   - Different `kind`s between the same pair are kept as separate edges by
 *     including `kind` in the edge key — this is why we use the explicit
 *     `addEdgeWithKey` API instead of relying on graphology's auto-keying.
 */
export function buildGraph(input: BuildGraphInput, options: BuildGraphOptions = {}): LodestoneGraph {
  const { includeExternalStubs = false } = options;
  // MultiDirectedGraph (vs DirectedGraph) so that distinct edge `kind`s
  // between the same (from, to) pair can coexist — e.g. "calls" + "imports"
  // both linking module A → module B. Matches §08's `EdgeRow` composite key
  // `(from_id, to_id, kind)`. Weight aggregation across same-(from,to,kind)
  // triples is still done explicitly via `edgeKey` lookup.
  const graph: LodestoneGraph = new MultiDirectedGraphCtor<
    GraphNodeAttributes,
    GraphEdgeAttributes
  >({ allowSelfLoops: true });

  // Pass 1 — add a node for every known symbol.
  for (const sym of input.symbols) {
    if (!graph.hasNode(sym.symbol)) {
      graph.addNode(sym.symbol, { symbol: sym, external: false });
    }
  }

  // Pass 2 — add edges. Stub external nodes for unresolved targets only
  // when the caller asked for them; otherwise drop the edge entirely so
  // the public surface stays internal-only.
  for (const edge of input.edges) {
    const fromKnown = graph.hasNode(edge.from);
    const toKnown = graph.hasNode(edge.to);
    if (!includeExternalStubs && (!fromKnown || !toKnown)) {
      continue;
    }
    if (!fromKnown) {
      graph.addNode(edge.from, { symbol: null, external: true });
    }
    if (!toKnown) {
      graph.addNode(edge.to, { symbol: null, external: true });
    }

    const key = edgeKey(edge.from, edge.to, edge.kind);
    if (graph.hasEdge(key)) {
      const existing = graph.getEdgeAttributes(key);
      graph.setEdgeAttribute(key, "weight", existing.weight + (edge.weight ?? 1));
    } else {
      graph.addDirectedEdgeWithKey(key, edge.from, edge.to, {
        kind: edge.kind,
        weight: edge.weight ?? 1,
      });
    }
  }

  return graph;
}

/**
 * Stable edge key including `kind` so calls + imports between the same pair
 * are distinct edges.
 */
function edgeKey(from: string, to: string, kind: EdgeKind): string {
  return `${from}${to}${kind}`;
}

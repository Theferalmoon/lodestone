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

import { MultiDirectedGraph } from "graphology";
import type { Edge, EdgeKind, LodestoneSymbol } from "@lodestone/shared";

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
export type LodestoneGraph = MultiDirectedGraph<GraphNodeAttributes, GraphEdgeAttributes>;

export interface BuildGraphInput {
  symbols: readonly LodestoneSymbol[];
  edges: readonly Edge[];
}

/**
 * Build a directed graphology Graph from the union of all parsers' output.
 *
 * Behaviour:
 *   - One node per `LodestoneSymbol` keyed by `symbol.symbol`.
 *   - Edges to a target id that isn't in the symbol set are kept by
 *     synthesizing a stub node with `{ external: true, symbol: null }`.
 *     This keeps PageRank's adjacency complete — dropping the edge would
 *     mute the source node's outbound contribution.
 *   - Self-loops are accepted (recursive functions exist).
 *   - Repeated `(from, to, kind)` triples increment `weight` rather than
 *     adding a parallel edge. The single-edge model fits a `DirectedGraph`
 *     (vs `MultiDirectedGraph`) and matches the §08 SQLite EdgeRow model
 *     which keys on `(from_id, to_id, kind)` with a single `weight` column.
 *   - Different `kind`s between the same pair are kept as separate edges by
 *     including `kind` in the edge key — this is why we use the explicit
 *     `addEdgeWithKey` API instead of relying on graphology's auto-keying.
 */
export function buildGraph(input: BuildGraphInput): LodestoneGraph {
  // MultiDirectedGraph (vs DirectedGraph) so that distinct edge `kind`s
  // between the same (from, to) pair can coexist — e.g. "calls" + "imports"
  // both linking module A → module B. Matches §08's `EdgeRow` composite key
  // `(from_id, to_id, kind)`. Weight aggregation across same-(from,to,kind)
  // triples is still done explicitly via `edgeKey` lookup.
  const graph: LodestoneGraph = new MultiDirectedGraph<
    GraphNodeAttributes,
    GraphEdgeAttributes
  >({ allowSelfLoops: true });

  // Pass 1 — add a node for every known symbol.
  for (const sym of input.symbols) {
    if (!graph.hasNode(sym.symbol)) {
      graph.addNode(sym.symbol, { symbol: sym, external: false });
    }
  }

  // Pass 2 — add edges. Stub external nodes for unresolved targets.
  for (const edge of input.edges) {
    if (!graph.hasNode(edge.from)) {
      // The source isn't in the symbol set — this shouldn't normally happen
      // (parsers attach each ParserEdge to a known symbol id), but we tolerate
      // it by stubbing rather than throwing.
      graph.addNode(edge.from, { symbol: null, external: true });
    }
    if (!graph.hasNode(edge.to)) {
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

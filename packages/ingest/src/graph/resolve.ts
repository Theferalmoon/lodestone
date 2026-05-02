// SPDX-License-Identifier: Apache-2.0
// Edge resolution — turn parser-level ParserEdge {from, to_name, to_path?}
// records into resolved Edge {from, to, kind, weight} records by looking up
// the target symbol in a cross-file symbol table.
//
// §06 emits ParserEdges that carry the *bare or qualified* target name as
// written in source (e.g. "User::login", "lodash") plus an optional
// `to_path` resolution hint (e.g. an import source string). §07 owns the
// actual cross-file resolution: this module builds a name → symbol-id
// index from the union of all parsed `LodestoneSymbol.symbol` ids and
// matches each ParserEdge against it.
//
// Unresolved edges are not dropped — they are returned with
// `resolved: false` so the graph builder can decide whether to add a stub
// external node (current default) or skip them.

import type { Edge, EdgeKind, LodestoneSymbol } from "@lodestone/shared";

import type { ParserEdge } from "../parsers/base.js";

/**
 * One resolved-or-not edge. `to` is the canonical symbol id when
 * `resolved=true`, or the raw `to_name` (suitable for use as a stub
 * external-node key) when `resolved=false`.
 */
export interface ResolvedEdge extends Edge {
  resolved: boolean;
}

export interface ResolveResult {
  edges: ResolvedEdge[];
  /** Distinct unresolved target names — useful for diagnostics + golden fixtures. */
  unresolved: string[];
}

/**
 * Build a resolution index from the union of all parsed symbols.
 *
 * Two indexes are kept:
 *   - `byId`: exact id → id (covers the common case where a parser already
 *     emits a fully-qualified id as the edge target).
 *   - `byTail`: trailing segment of the canonical id (the symbol's local
 *     name, e.g. "login" from "src/auth.ts::User::login") → list of ids.
 *     Used as a fallback when the parser emits a bare name and the
 *     `to_path` hint matches the symbol's path.
 */
function buildIndex(symbols: readonly LodestoneSymbol[]): {
  byId: Map<string, string>;
  byTail: Map<string, string[]>;
} {
  const byId = new Map<string, string>();
  const byTail = new Map<string, string[]>();

  for (const sym of symbols) {
    byId.set(sym.symbol, sym.symbol);

    // Tail segment: everything after the last "::".
    const idx = sym.symbol.lastIndexOf("::");
    const tail = idx >= 0 ? sym.symbol.slice(idx + 2) : sym.symbol;
    const bucket = byTail.get(tail);
    if (bucket) {
      bucket.push(sym.symbol);
    } else {
      byTail.set(tail, [sym.symbol]);
    }
  }

  return { byId, byTail };
}

/**
 * Try to resolve a single ParserEdge against the symbol index.
 *
 * Resolution order:
 *   1. Exact match on canonical id (`to_name` IS already a fully-qualified id).
 *   2. Tail match where the candidate's path equals `to_path` (when provided).
 *   3. Tail match where the candidate's path equals the source symbol's path
 *      (same-file fallback — parsers emit bare names for in-file calls).
 *   4. Unique tail match (one and only one symbol shares this local name).
 *
 * Returns the resolved canonical id, or `null` when ambiguous / not found.
 */
function resolveOne(
  edge: ParserEdge,
  fromPath: string | undefined,
  index: { byId: Map<string, string>; byTail: Map<string, string[]> },
  symbolsById: Map<string, LodestoneSymbol>,
): string | null {
  // (1) exact id match
  const exact = index.byId.get(edge.to_name);
  if (exact) return exact;

  // Tail of `to_name` — "User::login" → "login", "login" → "login".
  const idx = edge.to_name.lastIndexOf("::");
  const tail = idx >= 0 ? edge.to_name.slice(idx + 2) : edge.to_name;
  const candidates = index.byTail.get(tail);
  if (!candidates || candidates.length === 0) return null;

  // (2) path-hint match — caller said "this came from ./y" and we have a
  // candidate whose path matches that hint.
  if (edge.to_path) {
    const hintMatches = candidates.filter((id) => {
      const sym = symbolsById.get(id);
      return sym !== undefined && pathHintMatches(sym.path, edge.to_path!);
    });
    if (hintMatches.length === 1) return hintMatches[0]!;
  }

  // (3) same-file fallback — the source symbol's file is the most likely
  // home for the called name when no other hint is available.
  if (fromPath) {
    const sameFile = candidates.filter((id) => {
      const sym = symbolsById.get(id);
      return sym !== undefined && sym.path === fromPath;
    });
    if (sameFile.length === 1) return sameFile[0]!;
  }

  // (4) unique tail match — exactly one symbol with this local name globally.
  if (candidates.length === 1) return candidates[0]!;

  // Ambiguous (multiple candidates, no disambiguation signal): leave unresolved.
  return null;
}

/**
 * Loose path-hint match. Parsers emit `to_path` as it appears in the import
 * statement (e.g. "./y", "../auth", "lodash") — not as a resolved filesystem
 * path. We accept a candidate when:
 *   - candidate.path equals the hint (rare, but possible for absolute hints), or
 *   - candidate.path's basename (without extension) matches the hint's tail
 *     segment after stripping leading "./" / "../" segments.
 */
function pathHintMatches(candidatePath: string, hint: string): boolean {
  if (candidatePath === hint) return true;
  // Strip leading ./ and ../ segments from the hint.
  let normalized = hint;
  while (normalized.startsWith("./") || normalized.startsWith("../")) {
    normalized = normalized.slice(normalized.indexOf("/") + 1);
  }
  // Strip extension from the candidate path's basename.
  const slash = candidatePath.lastIndexOf("/");
  const base = slash >= 0 ? candidatePath.slice(slash + 1) : candidatePath;
  const dot = base.lastIndexOf(".");
  const baseNoExt = dot >= 0 ? base.slice(0, dot) : base;
  // Compare the hint's last path segment (also without extension) against
  // the candidate basename.
  const normSlash = normalized.lastIndexOf("/");
  const normBase = normSlash >= 0 ? normalized.slice(normSlash + 1) : normalized;
  const normDot = normBase.lastIndexOf(".");
  const normBaseNoExt = normDot >= 0 ? normBase.slice(0, normDot) : normBase;
  return baseNoExt === normBaseNoExt;
}

/**
 * Resolve a batch of ParserEdges to canonical Edge records.
 *
 * - Aggregates weight when the same `(from, to, kind)` triple appears
 *   multiple times (e.g. a function calling another function in a loop —
 *   the parser may emit one ParserEdge per call site).
 * - Unresolved edges are kept (with `resolved: false` and `to = to_name`)
 *   so the graph builder can stub them as external nodes if it wants.
 */
export function resolveEdges(input: {
  symbols: readonly LodestoneSymbol[];
  edges: readonly ParserEdge[];
}): ResolveResult {
  const index = buildIndex(input.symbols);
  const symbolsById = new Map(input.symbols.map((s) => [s.symbol, s] as const));

  // Map source-id → its source path. Needed for the same-file fallback.
  const fromPathById = new Map<string, string>();
  for (const sym of input.symbols) {
    fromPathById.set(sym.symbol, sym.path);
  }

  // Aggregate by (from, to, kind) so parallel parser-emitted edges fold
  // into a single weighted edge.
  const aggregated = new Map<string, ResolvedEdge>();
  const unresolvedSet = new Set<string>();

  for (const pe of input.edges) {
    const fromPath = fromPathById.get(pe.from);
    const resolvedId = resolveOne(pe, fromPath, index, symbolsById);
    const to = resolvedId ?? pe.to_name;
    const resolved = resolvedId !== null;
    if (!resolved) unresolvedSet.add(pe.to_name);

    const key = makeEdgeKey(pe.from, to, pe.kind);
    const existing = aggregated.get(key);
    if (existing) {
      existing.weight = (existing.weight ?? 1) + 1;
    } else {
      aggregated.set(key, {
        from: pe.from,
        to,
        kind: pe.kind,
        weight: 1,
        resolved,
      });
    }
  }

  return {
    edges: Array.from(aggregated.values()),
    unresolved: Array.from(unresolvedSet).sort(),
  };
}

/** Stable key for `(from, to, kind)` aggregation. */
function makeEdgeKey(from: string, to: string, kind: EdgeKind): string {
  return `${from} ${to} ${kind}`;
}

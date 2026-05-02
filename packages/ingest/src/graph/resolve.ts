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
  // candidate whose path matches that hint, resolved relative to fromPath's
  // directory. Bare-name hints like "lodash" never match here because they
  // don't disambiguate between same-basename internal candidates.
  const hasRelativeHint = edge.to_path !== undefined &&
    (edge.to_path.startsWith("./") || edge.to_path.startsWith("../") || edge.to_path.startsWith("/"));
  if (edge.to_path) {
    const hintMatches = candidates.filter((id) => {
      const sym = symbolsById.get(id);
      return sym !== undefined && pathHintMatches(sym.path, edge.to_path!, fromPath);
    });
    if (hintMatches.length === 1) return hintMatches[0]!;
    // Multiple matches that resolve to the same file is also OK — the
    // graph treats them as parallel edges and aggregates weight.
    if (hintMatches.length > 1) return hintMatches[0]!;
  }

  // §07 RED #2: a relative path hint that DIDN'T resolve to any candidate
  // expresses positive intent ("the symbol lives in this specific file
  // relative to me"). Falling through to same-file or unique-tail
  // heuristics would silently match an unrelated same-basename file, which
  // is exactly the bug the brief flagged. Bail out as unresolved.
  if (hasRelativeHint) return null;

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
 * Path-hint match (RED §07 #2 fix). Parsers emit `to_path` as it appears
 * in the import statement (e.g. "./y", "../auth", "lodash"). We resolve
 * the hint **against `dirname(fromPath)`** when it is relative, then
 * compare against the candidate's full repo-relative path (with extension
 * + `/index.<ext>` variants stripped). This prevents the previous
 * basename-only compare from silently matching a same-basename file in a
 * different directory.
 *
 * Bare-name hints (no slash, no leading `./` or `../`) like `lodash` or
 * `react` are external module names; they don't disambiguate between
 * internal symbols, so this returns `false` for them. The caller falls
 * through to the same-file / unique-tail branches.
 */
function pathHintMatches(candidatePath: string, hint: string, fromPath: string | undefined): boolean {
  // Exact full-path match — covers absolute hints + already-canonical paths.
  if (candidatePath === hint) return true;

  const isRelative = hint.startsWith("./") || hint.startsWith("../") || hint.startsWith("/");
  if (!isRelative) {
    // Bare module specifier — never disambiguates between internal symbols.
    return false;
  }

  // Resolve the hint against fromPath's directory using POSIX-style
  // segments (parsers emit POSIX-relative paths). Without fromPath we
  // can't resolve a relative hint, so refuse to match.
  if (!fromPath) return false;
  const resolved = posixResolveRelative(fromPath, hint);
  if (!resolved) return false;

  // Strip extension from the candidate's path.
  const candNoExt = stripExt(candidatePath);
  const resolvedNoExt = stripExt(resolved);

  // Match either exact path or `<resolved>/index` (Node-style index resolution).
  if (candNoExt === resolvedNoExt) return true;
  if (candNoExt === `${resolvedNoExt}/index`) return true;

  return false;
}

/**
 * Resolve `hint` (which starts with `./`, `../`, or `/`) against the
 * directory of `fromPath`, returning a normalized POSIX path. Returns
 * `null` if the hint escapes the root (too many `..` segments).
 */
function posixResolveRelative(fromPath: string, hint: string): string | null {
  let baseDir: string[];
  if (hint.startsWith("/")) {
    // Absolute hint: ignore fromPath dir, normalize hint segments alone.
    baseDir = [];
  } else {
    const slash = fromPath.lastIndexOf("/");
    baseDir = slash >= 0 ? fromPath.slice(0, slash).split("/").filter((s) => s.length > 0) : [];
  }
  const hintSegs = hint.split("/").filter((s) => s.length > 0);
  const out = [...baseDir];
  for (const seg of hintSegs) {
    if (seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join("/");
}

function stripExt(p: string): string {
  const slash = p.lastIndexOf("/");
  const base = slash >= 0 ? p.slice(slash + 1) : p;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return p; // no extension or leading dot only
  const dirPart = slash >= 0 ? p.slice(0, slash + 1) : "";
  return dirPart + base.slice(0, dot);
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

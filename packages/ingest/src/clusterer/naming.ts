// SPDX-License-Identifier: Apache-2.0
// Cluster-naming heuristic: dominant-verb + anchor-symbol + filename-fragment.
// Spec invariant: a cluster of `auth*` symbols MUST produce a name containing "auth"
// — this is achieved by letting the filename basename contribute as a name fragment
// when the dominant verb collides with the stoplist or fails to extract.

import type { NamingEvidence } from "@lodestone/shared";

/** Generic verbs that don't add cluster meaning; ignored when picking dominant. */
const VERB_STOPLIST = new Set(["get", "set", "do", "make", "run", "is", "has", "to"]);

/**
 * Tokenize a symbol qualified id like "src/auth.ts::User::login" into:
 *   - basename = "auth"
 *   - tail names = ["user", "login"]
 *
 * Used by the naming heuristic for both verb extraction and filename anchoring.
 */
export function tokenizeSymbol(qualifiedId: string): {
  basename: string;
  parts: string[];
} {
  const [pathPart, ...tail] = qualifiedId.split("::");
  const path = pathPart ?? "";
  const fileSeg = path.split("/").pop() ?? "";
  const basename = fileSeg.replace(/\.[^./]+$/, "").toLowerCase();
  // camelCase / snake_case split on each tail segment.
  const parts: string[] = [];
  for (const seg of tail) {
    parts.push(...splitIdent(seg).map((s) => s.toLowerCase()));
  }
  return { basename, parts };
}

/** camelCase + snake_case + kebab-case → words. "issueToken" -> ["issue","token"]. */
export function splitIdent(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Pick the most-frequent non-stoplist token across all member symbols.
 * Returns undefined when no non-stoplist token has count > 1.
 */
export function dominantVerb(memberSymbols: readonly string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const sym of memberSymbols) {
    const { parts } = tokenizeSymbol(sym);
    for (const tok of parts) {
      if (VERB_STOPLIST.has(tok)) continue;
      if (tok.length < 3) continue;
      counts.set(tok, (counts.get(tok) ?? 0) + 1);
    }
  }
  let best: { tok: string; count: number } | undefined;
  for (const [tok, count] of counts) {
    if (count < 2) continue;
    if (!best || count > best.count) best = { tok, count };
  }
  return best?.tok;
}

/**
 * Pick the most-frequent filename basename across members. Lets the cluster
 * name reflect the source file even when verb extraction fails — this is the
 * mechanism that satisfies the "auth-cluster name contains 'auth'" invariant.
 */
export function dominantBasename(memberSymbols: readonly string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const sym of memberSymbols) {
    const { basename } = tokenizeSymbol(sym);
    if (!basename) continue;
    counts.set(basename, (counts.get(basename) ?? 0) + 1);
  }
  let best: { name: string; count: number } | undefined;
  for (const [name, count] of counts) {
    if (!best || count > best.count) best = { name, count };
  }
  return best?.name;
}

/** Last identifier segment of a qualified id, lowercased. */
export function anchorShortName(anchor: string): string {
  const last = anchor.split("::").pop() ?? anchor;
  return splitIdent(last).join("-").toLowerCase() || "anonymous";
}

/**
 * Compose the cluster name. Order of preference:
 *   1. "<verb>-<basename>" if both extracted (e.g. "verify-auth")
 *   2. "<verb>-<anchor>" if no basename
 *   3. "cluster-<basename>" if basename only
 *   4. "cluster-<anchor>" as final fallback
 */
export function composeName(opts: {
  anchor: string;
  members: readonly string[];
}): { name: string; evidence: NamingEvidence } {
  const verb = dominantVerb(opts.members);
  const basename = dominantBasename(opts.members);
  const anchorShort = anchorShortName(opts.anchor);
  let name: string;
  if (verb && basename) name = `${verb}-${basename}`;
  else if (verb) name = `${verb}-${anchorShort}`;
  else if (basename) name = `cluster-${basename}`;
  else name = `cluster-${anchorShort}`;
  return {
    name,
    evidence: {
      dominant_verb: verb,
      anchor_symbol: opts.anchor,
      members_sampled: opts.members.length,
    },
  };
}

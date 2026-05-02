// SPDX-License-Identifier: Apache-2.0
// Lodestone — deterministic SKILL.md body templating from a Cluster.

import type { Cluster, SymbolRef } from "@lodestone/shared";

const TOP_N_FILES = 10;

/**
 * Render the markdown body for a SKILL.md card. Deterministic: same Cluster
 * input → identical bytes (modulo the frontmatter, which is rendered
 * separately and prepended by the caller).
 *
 * Codex v0.1.1 §10 YELLOW: equal-pagerank ties upstream can shuffle the
 * member/bridge input order. We apply a deterministic secondary sort —
 * pagerank desc, then symbol id asc — before rendering so the body bytes
 * are stable regardless of upstream array ordering.
 *
 * Sections:
 *   # <name>
 *
 *   <description paragraph>
 *
 *   ## Where it lives
 *   - path/a.ts
 *   - path/b.ts
 *
 *   ## Notable bridges        (only when cluster.bridges is non-empty)
 *   - path/x.ts::Foo::bar
 *
 *   ## Naming evidence        (only when naming is heuristic and useful)
 *   - dominant verb: `verify`
 *   - sampled members: 5
 */
export function renderBody(cluster: Cluster): string {
  const lines: string[] = [];
  lines.push(`# ${cluster.name}`, "");

  const desc = (cluster.description ?? "").trim();
  if (desc.length > 0) {
    lines.push(desc, "");
  }

  // Deterministic order — pagerank desc, then symbol id asc as tiebreak.
  const sortedMembers = sortByPageRank(cluster.members);
  const sortedBridges = sortByPageRank(cluster.bridges);

  lines.push("## Where it lives", "");
  const paths = topUniquePaths(sortedMembers, TOP_N_FILES);
  if (paths.length === 0) {
    lines.push("- _no member paths recorded_");
  } else {
    for (const p of paths) lines.push(`- ${p}`);
  }
  lines.push("");

  if (sortedBridges.length > 0) {
    lines.push("## Notable bridges", "");
    for (const b of sortedBridges) {
      lines.push(`- ${b.symbol}`);
    }
    lines.push("");
  }

  if (cluster.name_status === "heuristic") {
    const ev = cluster.naming_evidence;
    const evLines: string[] = [];
    if (ev.dominant_verb) {
      evLines.push(`- dominant verb: \`${ev.dominant_verb}\``);
    }
    if (typeof ev.members_sampled === "number") {
      evLines.push(`- sampled members: ${ev.members_sampled}`);
    }
    if (evLines.length > 0) {
      lines.push("## Naming evidence", "");
      lines.push(...evLines, "");
    }
  }

  // Always end with a single trailing newline (no double blank).
  while (lines.length > 1 && lines[lines.length - 1] === "" && lines[lines.length - 2] === "") {
    lines.pop();
  }
  if (lines[lines.length - 1] !== "") lines.push("");
  return lines.join("\n");
}

/**
 * Sort SymbolRefs by pagerank desc, then by symbol id asc as a deterministic
 * tiebreak. Returns a new array; never mutates the input.
 *
 * The tiebreak is critical for §10 YELLOW: equal-pagerank entries arriving
 * in arbitrary upstream order would otherwise produce different bodies on
 * different runs and thrash the SKILL.md disk file.
 */
function sortByPageRank(refs: readonly SymbolRef[]): SymbolRef[] {
  return [...refs].sort((a, b) => {
    const pra = a.pagerank ?? 0;
    const prb = b.pagerank ?? 0;
    if (prb !== pra) return prb - pra;
    return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0;
  });
}

function topUniquePaths(members: readonly SymbolRef[], limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of members) {
    if (!m.path) continue;
    if (seen.has(m.path)) continue;
    seen.add(m.path);
    out.push(m.path);
    if (out.length >= limit) break;
  }
  return out;
}

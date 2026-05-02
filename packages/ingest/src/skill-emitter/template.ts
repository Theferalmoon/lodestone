// SPDX-License-Identifier: Apache-2.0
// Lodestone — deterministic SKILL.md body templating from a Cluster.

import type { Cluster, SymbolRef } from "@lodestone/shared";

const TOP_N_FILES = 10;

/**
 * Render the markdown body for a SKILL.md card. Deterministic: same Cluster
 * input → identical bytes (modulo the frontmatter, which is rendered
 * separately and prepended by the caller).
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

  lines.push("## Where it lives", "");
  const paths = topUniquePaths(cluster.members, TOP_N_FILES);
  if (paths.length === 0) {
    lines.push("- _no member paths recorded_");
  } else {
    for (const p of paths) lines.push(`- ${p}`);
  }
  lines.push("");

  if (cluster.bridges.length > 0) {
    lines.push("## Notable bridges", "");
    for (const b of cluster.bridges) {
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

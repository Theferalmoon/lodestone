// SPDX-License-Identifier: Apache-2.0
// Cluster fixture builders shared by the skill-emitter tests.

import type { Cluster, SymbolRef } from "@lodestone/shared";

export interface MkClusterOpts {
  id?: string;
  name?: string;
  size?: number;
  bridges?: number;
  modularity?: number;
  description?: string;
  paths?: string[];
}

/**
 * Build a synthetic Cluster matching the §09 shape (POST-CODEX-001 fields
 * included). `size` controls how many synthetic members are generated; the
 * first `bridges` of those are also surfaced as bridges.
 */
export function mkCluster(opts: MkClusterOpts = {}): Cluster {
  const id = opts.id ?? "cluster000000001";
  const name = opts.name ?? "Auth pipeline";
  const size = opts.size ?? 5;
  const bridges = opts.bridges ?? 0;
  const modularity = opts.modularity ?? 0.6;
  const description =
    opts.description ?? `Cluster of ${size} symbols around the verb "verify".`;

  const paths = opts.paths ?? [
    "src/auth.ts",
    "src/auth.ts",
    "src/auth.ts",
    "src/util.ts",
    "src/util.ts",
    "src/middleware.ts",
    "src/middleware.ts",
    "src/handlers.ts",
    "src/handlers.ts",
    "src/extra.ts",
    "src/more.ts",
    "src/again.ts",
  ];

  const members: SymbolRef[] = [];
  for (let i = 0; i < size; i++) {
    const path = paths[i % paths.length]!;
    members.push({
      symbol: `${path}::sym_${i}`,
      path,
      range: { start_line: 1 + i, end_line: 10 + i },
      pagerank: 0.1 + i * 0.01,
    });
  }

  const bridgeRefs = members.slice(0, bridges);

  return {
    id,
    name,
    name_status: "heuristic",
    agent_instruction: "synthesize_name_from_members",
    naming_evidence: {
      anchor_symbol: members[0]?.symbol ?? "src/auth.ts::sym_0",
      members_sampled: size,
      dominant_verb: "verify",
    },
    description,
    size,
    members,
    bridges: bridgeRefs,
    diagnostics: {
      algorithm: "louvain",
      algorithm_version: "louvain@0.0",
      resolution: 1.5,
      seed: 42,
      graph_node_count: size + 5,
      graph_edge_count: size * 2,
      modularity,
      singleton_count: 0,
      bridge_count: bridges,
      stability_hash: id,
    },
  };
}

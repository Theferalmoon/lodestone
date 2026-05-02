// SPDX-License-Identifier: Apache-2.0
// Tiny hand-built 5-symbol / 4-edge fixture for builder + pagerank tests.
// Topology:
//
//     login ──calls──▶ verifyPassword
//        │                  │
//        │                  └─calls──▶ hashCompare
//        │
//        └─calls──▶ recordAttempt
//
//     unrelated   (isolated, no edges)
//
// The shape is deliberately small so PageRank ordering is hand-verifiable:
// `hashCompare` should rank highest (only target of one edge but downstream
// of two via `verifyPassword`); `unrelated` should rank lowest among the
// authentic nodes (zero in-degree).

import type { Edge, LodestoneSymbol } from "@lodestone/shared";

const PATH = "src/auth.ts";

function sym(name: string, kind: LodestoneSymbol["kind"] = "function"): LodestoneSymbol {
  return {
    symbol: `${PATH}::${name}`,
    path: PATH,
    range: { start_line: 1, end_line: 1 },
    language: "typescript",
    kind,
  };
}

export const TINY_SYMBOLS: LodestoneSymbol[] = [
  sym("login"),
  sym("verifyPassword"),
  sym("hashCompare"),
  sym("recordAttempt"),
  sym("unrelated"),
];

export const TINY_EDGES: Edge[] = [
  {
    from: `${PATH}::login`,
    to: `${PATH}::verifyPassword`,
    kind: "calls",
    weight: 1,
  },
  {
    from: `${PATH}::login`,
    to: `${PATH}::recordAttempt`,
    kind: "calls",
    weight: 1,
  },
  {
    from: `${PATH}::verifyPassword`,
    to: `${PATH}::hashCompare`,
    kind: "calls",
    weight: 1,
  },
  // External (unresolved) target — should become a stub external node.
  {
    from: `${PATH}::login`,
    to: "lodash",
    kind: "imports",
    weight: 1,
  },
];

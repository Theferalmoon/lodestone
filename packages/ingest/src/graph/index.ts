// SPDX-License-Identifier: Apache-2.0
// Public surface of @lodestone/ingest/graph — graph builder, edge resolution,
// PageRank, and the git-operation pause gate. Consumed by §08 (storage),
// §09 (clusterer), §12 (watcher), §15 (MCP graph tools).

export { buildGraph } from "./builder.js";
export type {
  BuildGraphInput,
  GraphEdgeAttributes,
  GraphNodeAttributes,
  LodestoneGraph,
} from "./builder.js";

export { pageRank } from "./pagerank.js";
export type { PageRankOptions } from "./pagerank.js";

export { resolveEdges } from "./resolve.js";
export type { ResolvedEdge, ResolveResult } from "./resolve.js";

export { shouldPause } from "./pause.js";

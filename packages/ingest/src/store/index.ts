// SPDX-License-Identifier: Apache-2.0
// Public surface of @lodestone/ingest/store - SQLite (better-sqlite3 + WAL +
// sqlite-vec) writer + reader, atomic ready.json marker, and the canonical
// query CTEs. Section 13 MCP server consumes openReader from this module per
// the POST-CODEX-001 amendment block of section 8.

export {
  openReader,
  openWriter,
  bootstrap,
  readSchemaVersion,
  closeDb,
  VECTOR_DIM,
  _resetWriterRegistry,
} from "./sqlite.js";
export type { OpenOptions } from "./sqlite.js";

export {
  writeSymbols,
  writeEdges,
  writePagerank,
  writeClassInheritance,
  writeEmbeddings,
  ensureSymbolEmbeddingsTable,
  isEdgeKind,
} from "./writer.js";
export type { EmbeddingRow, SymbolWriteContext } from "./writer.js";

export {
  getSymbol,
  getInboundEdges,
  getOutboundEdges,
  callersOf,
  calleesOf,
  impactOf,
  clusterMembers,
  vectorSearch,
} from "./reader.js";
export type { ReachabilityHit, VectorHit } from "./reader.js";

export {
  readReady,
  writeReady,
  assertReady,
  readyPath,
} from "./ready.js";
export type { ReadyMarker } from "./ready.js";

export {
  CALLERS_OF_SQL,
  CALLEES_OF_SQL,
  IMPACT_OF_SQL,
  CLUSTER_MEMBERS_SQL,
} from "./queries.js";

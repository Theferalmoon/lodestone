// SPDX-License-Identifier: Apache-2.0
// Public surface of @lodestone/ingest. Section 05 ships the embedder runtime;
// later sections (06 parsers, 07 graph builder) add their own subpaths.

export {
  load,
  pickEmbedderId,
  defaultModelId,
  isCoreMLEnabled,
  EmbedderLoadError,
  LOW_RAM_THRESHOLD_BYTES,
  MAX_BATCH,
} from "./embed/runtime.js";
export type {
  EmbedderHandle,
  EmbedderId,
  LoadOptions,
} from "./embed/runtime.js";

// Parser registry — section 06.
export { parserForFile } from "./parsers/index.js";
export type {
  AbstractParser,
  ParseResult,
  ClassInheritance,
  ParserEdge,
} from "./parsers/base.js";

// Graph builder + PageRank + edge resolution + git-pause gate — section 07.
export {
  buildGraph,
  pageRank,
  resolveEdges,
  shouldPause,
} from "./graph/index.js";
export type {
  BuildGraphInput,
  GraphEdgeAttributes,
  GraphNodeAttributes,
  LodestoneGraph,
  PageRankOptions,
  ResolvedEdge,
  ResolveResult,
} from "./graph/index.js";

// File watcher + coalesce + git-pause integration — section 12.
export {
  createWatcher,
  startWatcher,
  BUILTIN_IGNORE_PATTERNS,
} from "./watcher/index.js";
export type {
  FileBatch,
  FileBatchReason,
  RawEventKind,
  Watcher,
  WatcherEvent,
  WatcherOptions,
  WatcherStats,
} from "./watcher/index.js";

// Storage layer — section 08. SQLite (better-sqlite3 + WAL) + sqlite-vec
// virtual table for symbol-body vectors + atomic ready.json marker. Section
// 13 MCP server consumes openReader from this module per the POST-CODEX-001
// amendment block of section 8.
export {
  openReader,
  openWriter,
  bootstrap,
  readSchemaVersion,
  closeDb,
  VECTOR_DIM,
  writeSymbols,
  writeEdges,
  writePagerank,
  writeClassInheritance,
  writeEmbeddings,
  ensureSymbolEmbeddingsTable,
  getSymbol,
  getInboundEdges,
  getOutboundEdges,
  callersOf,
  calleesOf,
  impactOf,
  clusterMembers,
  vectorSearch,
  readReady,
  writeReady,
  assertReady,
  readyPath,
  CALLERS_OF_SQL,
  CALLEES_OF_SQL,
  IMPACT_OF_SQL,
  CLUSTER_MEMBERS_SQL,
} from "./store/index.js";
export type {
  EmbeddingRow,
  OpenOptions,
  ReachabilityHit,
  ReadyMarker,
  SymbolWriteContext,
  VectorHit,
} from "./store/index.js";

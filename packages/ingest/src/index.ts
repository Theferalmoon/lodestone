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
  writeFeedback,
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

// Skill emitter — section 10. Cluster -> SKILL.md card emission, with
// idempotency via SHA256 frontmatter check and SQLite mirror per
// POST-CODEX-001 amendment block of section 10.
export {
  emit as emitSkill,
  shouldEmit,
  expireOld,
  slugify,
  renderFrontmatter,
  parseFrontmatter,
  sourceToMaturity,
  computeConfidence,
  observedDaysFrom,
  confidenceInputsFromCluster,
  renderBody as renderSkillBody,
  writeSkill,
  writeSkills,
  sha256Hex,
} from "./skill-emitter/index.js";
export type {
  EmitConfig,
  EmitResult,
  EmitSource,
  SelectionConfig,
  SelectionDecision,
  SelectionInputs,
  ArchiveConfig,
  ArchiveResult,
  FrontmatterFields,
  ConfidenceInputs,
  PersistResult,
} from "./skill-emitter/index.js";

// Seed skills — section 11. Deterministic high-confidence Skills derived
// from §06 ParseResults (class_inheritance triples + import edges). Each
// emitted Skill carries `maturity: "deterministic_seed"` and is ready for
// the §10 emit pathway (writeSkill / writeSkills).
export {
  seedSkillsFor,
  detectErrorHierarchy,
  detectFrameworks,
  SEED_CONFIDENCE,
} from "./seed-skills/index.js";
export type {
  SeedSkillInput,
  SeedSkillRecord,
  SeedSkillsConfig,
  SeedSkillSource,
} from "./seed-skills/index.js";

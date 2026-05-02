// SPDX-License-Identifier: Apache-2.0
// Public surface of @lodestone/mcp-server. Other packages (tests, CLI wiring,
// future Forge plugin host) import from here.

export type {
  LodestoneToolResponseV13,
  LodestoneChannelV0,
} from "./envelope.js";
export {
  LODESTONE_CHANNEL_V0,
  ChannelValidationError,
  validateChannel,
  wrapOk,
  wrapErr,
  wrapNotImplemented,
  wrapNotReady,
  NOT_READY_PROVENANCE,
  emptyDiagnostics,
} from "./envelope.js";

export { BackpressureError, InflightCap } from "./inflight.js";
export type { InflightSlot } from "./inflight.js";

export { enforceMaxResponseKb, envelopeByteLength } from "./truncate.js";

export { assertLocalStdioTrust } from "./auth.js";

export { openReader } from "./client/sqlite.js";
export type { ReaderHandle } from "./client/sqlite.js";

export {
  TOOL_REGISTRY,
  TOOL_NAMES_ALPHABETICAL,
  buildActiveRegistry,
} from "./tools/index.js";
export type { ToolEntry, BuildOptions } from "./tools/index.js";

export { createServer } from "./server.js";
export type { CreateServerOptions, CreatedServer } from "./server.js";

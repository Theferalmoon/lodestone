// SPDX-License-Identifier: Apache-2.0
// LodestoneToolResponseV13<T> — channel-augmented envelope wrapper for §13 MCP
// surface. Extends @lodestone/shared's LodestoneToolResponse<T> with a
// load-bearing `channel` field per the POST-FORGE-VISION amendment §2 (claude-plan.md):
//   - v0 ships with a single channel — "code" — addressing the per-project KG.
//   - The wire format reserves the field on every tool envelope so Forge v1
//     can later add `channel: "ops"` and `channel: "training"` without
//     breaking the v0 contract.
//   - v0 implementations MUST validate the field equals "code" and fail loudly
//     otherwise. Defense-in-depth against future channel mis-routing.

import { v7 as uuidv7 } from "uuid";

import type {
  LodestoneToolResponse,
  Provenance,
  Diagnostics,
} from "@lodestone/shared";

/**
 * The canonical channel literal for v0. Forge v1 will introduce additional
 * literals; until then any non-"code" channel is rejected by `validateChannel`.
 */
export const LODESTONE_CHANNEL_V0 = "code" as const;
export type LodestoneChannelV0 = typeof LODESTONE_CHANNEL_V0;

/**
 * v0+ envelope. Adds `channel` (load-bearing for Forge compatibility) and an
 * optional `truncated`/`backpressure` top-level flag — both surface server-side
 * conditions that callers can check without parsing diagnostics.warnings.
 */
export interface LodestoneToolResponseV13<T> extends LodestoneToolResponse<T> {
  /** Channel discriminant. v0 only emits "code"; future Forge channels reuse the field. */
  channel: LodestoneChannelV0;
  /** Set true when truncate.ts dropped tail results to fit max_response_kb. */
  truncated?: boolean;
  /** Set true when the server rejected the request because in-flight cap was exceeded. */
  backpressure?: boolean;
}

export interface NotReadyDiagnostic {
  warning: string;
}

/** Default not-ready provenance — used by tools when ready.json is missing/false. */
export const NOT_READY_PROVENANCE: Provenance = {
  is_git_repo: false,
  head_commit: null,
  indexed_commit: null,
  dirty_at_index: false,
  dirty_now: false,
  commits_since_index: 0,
  has_upstream: false,
  upstream_branch: null,
  commits_behind_upstream: 0,
  indexed_at: null,
  staleness_seconds: -1,
  index_epoch: 0,
  source: "not_ready",
};

/** Default diagnostics shape — tools merge their own warnings on top. */
export function emptyDiagnostics(): Diagnostics {
  return {
    coverage: 0,
    coverage_basis: "files-indexed-vs-non-ignored",
  };
}

/**
 * Validate the `channel` field on an inbound request. v0 accepts only "code".
 * Throws ChannelValidationError on mismatch — server.ts converts to an error
 * envelope. Future Forge channels (ops, training) will widen the accept set
 * without breaking v0 callers.
 */
export class ChannelValidationError extends Error {
  readonly received: string | undefined;
  constructor(received: unknown) {
    const recv =
      typeof received === "string" ? received : received === undefined ? "undefined" : String(received);
    super(
      `Lodestone v0 only accepts channel="code"; received channel=${JSON.stringify(recv)}. ` +
        `(Forge channels "ops" and "training" are reserved for v1.)`,
    );
    this.name = "ChannelValidationError";
    this.received = typeof received === "string" ? received : undefined;
  }
}

/**
 * Validates the inbound `channel` field. Accepts undefined (treated as "code"
 * for backward-compat with the §02 LodestoneToolResponse shape that predates
 * the field) AND the literal "code". Rejects anything else.
 */
export function validateChannel(input: unknown): LodestoneChannelV0 {
  if (input === undefined || input === null) return LODESTONE_CHANNEL_V0;
  if (input === LODESTONE_CHANNEL_V0) return LODESTONE_CHANNEL_V0;
  throw new ChannelValidationError(input);
}

/**
 * Build a successful envelope. Generates a UUID v7 request_id, applies the
 * channel field, and merges the supplied provenance/diagnostics. Helpers like
 * `wrapErr` and `wrapNotReady` build on top of this.
 */
export function wrapOk<T>(
  results: T[],
  channel: LodestoneChannelV0,
  opts: {
    provenance?: Provenance;
    diagnostics?: Diagnostics;
    requestId?: string;
  } = {},
): LodestoneToolResponseV13<T> {
  return {
    request_id: opts.requestId ?? uuidv7(),
    channel,
    results,
    provenance: opts.provenance ?? NOT_READY_PROVENANCE,
    diagnostics: opts.diagnostics ?? emptyDiagnostics(),
  };
}

/**
 * Build an error envelope: empty results, supplied warning prepended to
 * diagnostics.warnings. Returns a well-formed envelope so the MCP transport
 * layer never has to special-case errors.
 */
export function wrapErr<T = unknown>(
  message: string,
  channel: LodestoneChannelV0,
  opts: { provenance?: Provenance; requestId?: string } = {},
): LodestoneToolResponseV13<T> {
  const diagnostics: Diagnostics = {
    ...emptyDiagnostics(),
    warnings: [message],
  };
  return wrapOk<T>([], channel, {
    diagnostics,
    provenance: opts.provenance,
    requestId: opts.requestId,
  });
}

/**
 * Standard "not_implemented" envelope used by every stub handler in §13. The
 * stubs return this verbatim until §14–§17 swap in real implementations.
 */
export function wrapNotImplemented<T = unknown>(
  channel: LodestoneChannelV0,
): LodestoneToolResponseV13<T> {
  return wrapErr<T>("not_implemented", channel);
}

/** Standard "index not ready" envelope used when ready.json is missing/false. */
export function wrapNotReady<T = unknown>(
  channel: LodestoneChannelV0,
): LodestoneToolResponseV13<T> {
  return wrapErr<T>("index not ready, see lodestone status", channel, {
    provenance: NOT_READY_PROVENANCE,
  });
}

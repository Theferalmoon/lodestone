// SPDX-License-Identifier: Apache-2.0
// `feedback` tool — §17. The ONLY MCP write tool in v0. Persists an agent
// signal about a prior tool call to the SQLite `feedback` table. Every other
// MCP tool runs through a read-only handle (client/sqlite.ts); feedback opens
// a SHORT-LIVED writer handle inside this module and closes it before
// returning. That separation is the trust boundary — the read path can never
// be coerced into a write, and the write path can't be reached without
// passing zod validation here.
//
// The `request_id` field links this feedback record to the agent's earlier
// tool call envelope (§13's UUID v7 stamp). That linkage is load-bearing for
// v0.5 specialty-agent training-pair extraction (POST-FORGE-VISION amendment):
// we will replay (prior tool input → prior tool output → agent feedback) as
// supervised pairs without ever leaving the laptop.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

import {
  FEEDBACK_SIGNALS,
  type FeedbackEvent,
} from "@lodestone/shared";
import {
  bootstrap,
  closeDb,
  openWriter,
  writeFeedback,
} from "@lodestone/ingest/store";

import {
  LODESTONE_CHANNEL_V0,
  emptyDiagnostics,
  wrapErr,
  wrapOk,
  type LodestoneToolResponseV13,
} from "../envelope.js";
import { resolveSqlitePath } from "./_shared.js";

/** Agent-supplied notes are capped at 2 KB before persistence; oversized notes
 * are truncated and the persisted record carries `note_truncated: true` in
 * diagnostics so downstream consumers know the body is incomplete. */
export const NOTE_MAX_BYTES = 2048;

export const description =
  "Record agent feedback on a prior Lodestone tool call. Required fields: the tool name (`query`, `cluster`, `context`, etc.), the prior call's `request_id` (UUID v7 from the prior envelope), and a `signal` literal (`useful` | `not_useful` | `wrong` | `stale`). Optional `note` (≤2 KB) explains why. Feedback is the training signal Lodestone uses to improve cluster names, skill cards, and ranking — call this whenever a prior tool call was meaningfully helpful or unhelpful.";

export const inputSchema = z.object({
  tool: z.string().min(1, "tool must be non-empty"),
  request_id: z.string().min(1, "request_id is required (UUID from prior call)"),
  signal: z.enum(FEEDBACK_SIGNALS),
  note: z.string().optional(),
  channel: z.literal("code").optional(),
});

export type FeedbackToolInput = z.infer<typeof inputSchema>;

/** Result payload returned inside the envelope on a successful append. */
export interface FeedbackAck {
  ack: true;
  /** AUTOINCREMENT id of the persisted row. Useful for the future `lodestone
   * feedback stats` CLI surface (v0.5). */
  id: number;
  /** Server-stamped ISO-8601 timestamp; the agent never supplies this. */
  recorded_at: string;
}

/** Handler dependency overrides — used by tests to point at a temp DB and to
 * inject deterministic timestamps. Production callers leave them unset; the
 * default resolver consults `LODESTONE_CWD` env var (set by §13's main()) and
 * falls back to `process.cwd()`. */
export interface HandlerOptions {
  /** Override the resolved cwd. Tests pass a tmpdir. */
  cwd?: string;
  /** Override `new Date().toISOString()` for deterministic test assertions. */
  now?: () => string;
}

/**
 * Truncate `note` to NOTE_MAX_BYTES at a UTF-8 byte boundary. Returns the
 * possibly-truncated note plus a flag indicating whether truncation occurred.
 * The boundary is computed by encoding to bytes, slicing, then decoding with
 * `fatal: false` so a multi-byte codepoint split mid-byte becomes U+FFFD —
 * never an exception.
 */
export function truncateNote(note: string): { value: string; truncated: boolean } {
  const encoded = new TextEncoder().encode(note);
  if (encoded.byteLength <= NOTE_MAX_BYTES) {
    return { value: note, truncated: false };
  }
  const slice = encoded.slice(0, NOTE_MAX_BYTES);
  const value = new TextDecoder("utf-8", { fatal: false }).decode(slice);
  return { value, truncated: true };
}

/**
 * Build the handler bound to a specific options bag. The exported `handler`
 * uses production defaults; tests instantiate their own with a temp cwd.
 */
export function makeHandler(opts: HandlerOptions = {}) {
  return async function feedbackHandler(
    input: unknown,
  ): Promise<LodestoneToolResponseV13<FeedbackAck>> {
    // Validate input shape. zod returns a structured error; we surface it
    // through the standard error envelope rather than throwing — the MCP
    // transport never sees a thrown exception from this tool.
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      return wrapErr<FeedbackAck>(`feedback validation failed: ${message}`, LODESTONE_CHANNEL_V0);
    }

    const { tool, request_id, signal, note } = parsed.data;

    let storedNote: string | undefined;
    let noteTruncated = false;
    if (note !== undefined) {
      const { value, truncated } = truncateNote(note);
      storedNote = value;
      noteTruncated = truncated;
    }

    const recordedAt = (opts.now ?? (() => new Date().toISOString()))();
    const event: FeedbackEvent = {
      tool,
      request_id,
      signal,
      ...(storedNote !== undefined ? { note: storedNote } : {}),
      recorded_at: recordedAt,
    };

    // Resolve via the §14 _shared helper so cwd/env overrides stay consistent
    // across every tool. Explicit override wins (test paths); otherwise
    // resolveSqlitePath honors LODESTONE_CWD then falls back to process.cwd().
    const dbPath = opts.cwd !== undefined ? resolveSqlitePath(opts.cwd) : resolveSqlitePath();

    // Belt-and-suspenders: ensure the .lodestone/ dir exists before opening
    // the writer. openWriter mkdir's the parent for us, but we may also be
    // the very first writer in a fresh repo where `lodestone init` hasn't
    // run yet — fail soft by attempting bootstrap and continuing.
    try {
      mkdirSync(dirname(dbPath), { recursive: true });
    } catch {
      /* mkdir is best-effort; openWriter will surface a real failure below */
    }

    let db: ReturnType<typeof openWriter> | null = null;
    let id: number;
    try {
      db = openWriter(dbPath, { loadVec: false });
      // Idempotent — bootstrap is a no-op if the schema is current. Lets a
      // standalone MCP-server start (no preceding `lodestone init`) still
      // accept feedback without crashing.
      bootstrap(db);
      id = writeFeedback(db, event);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return wrapErr<FeedbackAck>(`feedback persist failed: ${message}`, LODESTONE_CHANNEL_V0);
    } finally {
      if (db) {
        try {
          closeDb(db);
        } catch {
          /* close errors are non-fatal; the registry releases on next open */
        }
      }
    }

    const diagnostics = emptyDiagnostics();
    if (noteTruncated) {
      diagnostics.warnings = [
        `note truncated to ${NOTE_MAX_BYTES} bytes (original exceeded the cap)`,
      ];
    }

    return wrapOk<FeedbackAck>(
      [
        {
          ack: true,
          id,
          recorded_at: recordedAt,
        },
      ],
      LODESTONE_CHANNEL_V0,
      { diagnostics },
    );
  };
}

/** Production handler — uses `process.cwd()` and live `Date`. */
export const handler = makeHandler();

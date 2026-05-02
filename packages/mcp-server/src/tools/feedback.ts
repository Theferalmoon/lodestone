// SPDX-License-Identifier: Apache-2.0
// `feedback` tool — §17. The ONLY MCP write tool in v0. Persists an agent
// signal about a prior tool call to the SQLite `feedback` table. Every other
// MCP tool runs through a read-only handle (client/sqlite.ts); feedback owns
// the writer surface and serializes all writes through a per-(cwd,db) cache.
// That separation is the trust boundary — the read path can never be coerced
// into a write, and the write path can't be reached without passing zod
// validation here.
//
// The `request_id` field links this feedback record to the agent's earlier
// tool call envelope (§13's UUID v7 stamp). That linkage is load-bearing for
// v0.5 specialty-agent training-pair extraction (POST-FORGE-VISION amendment):
// we will replay (prior tool input → prior tool output → agent feedback) as
// supervised pairs without ever leaving the laptop.
//
// v0.1.1 (impl-017 B2): the original implementation opened a fresh writer per
// call and closed it in a finally. Two concurrent calls hit the §08
// `writerRegistry` Map, which rejects a second open of the same path in the
// same process — the second call would error with "Lodestone writer already
// open". Now: a module-scope cached writer (lazy-opened on first call, reused
// thereafter) plus a per-DB-path Promise chain that serializes writes. 10
// concurrent feedback calls all land sequentially without any registry
// collision. Cross-process contention (a stray ingest writer) still surfaces
// the registry error, but with up-to-3 100ms back-off retries first; if the
// other writer never releases, we return a clear `WriterContentionError`
// envelope so the agent can surface a real diagnostic instead of a stack
// trace.
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
import { resolveSqlitePath, toMcpInputSchema } from "./_shared.js";

type WriterDb = ReturnType<typeof openWriter>;

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

/** Pre-computed JSON-Schema-7 view of `inputSchema` for the MCP `tools/list`
 * surface. Pre-compute at module load — see `toMcpInputSchema` JSDoc. */
export const jsonSchema = toMcpInputSchema(inputSchema);

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
 * Error class used internally to carry the dedicated `writer_contention`
 * diagnostic warning into the envelope. Surfaced when the §08 writerRegistry
 * collision survives all retries — i.e., another long-lived writer (typically
 * an ingest pass in another process) is holding the file lock.
 */
class WriterContentionError extends Error {
  constructor(public readonly dbPath: string, public readonly attempts: number) {
    super(
      `feedback writer contention on ${dbPath}: another writer is holding the lock ` +
        `(${attempts} retries exhausted). Wait for the in-flight ingest/feedback to finish, ` +
        `then retry — feedback never blocks indefinitely.`,
    );
    this.name = "WriterContentionError";
  }
}

const MAX_OPEN_RETRIES = 3;
const RETRY_BACKOFF_MS = 100;

/**
 * Cached writer state. Keyed by absolute db path so a single Node process can
 * serve multiple Lodestone projects (rare, but the test harness exercises
 * exactly this — different tmp dirs per test). Cleared by `_resetCachedWriters`
 * for test isolation.
 */
interface WriterCacheEntry {
  /** Resolved writer handle, or in-flight open. */
  db: WriterDb;
  /** Tail of the per-path serialization chain. New writes await this. */
  tail: Promise<unknown>;
}

const writerCache = new Map<string, WriterCacheEntry>();
/**
 * In-flight open dedupe. Multiple concurrent first-callers must NOT each call
 * `openWriter` — they would all collide on the §08 writerRegistry. Instead the
 * first caller stores its Promise here, and every subsequent concurrent
 * caller awaits the same Promise. Cleared once the open resolves (success
 * or failure).
 */
const inflightOpens = new Map<string, Promise<WriterCacheEntry>>();

/** Sleep helper for retry back-off. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Open the writer with bounded retries on §08 registry collision. The Map
 * collision throws a synchronous Error containing "Lodestone writer already
 * open"; we sniff that string (the §08 message is stable) and back off. Other
 * errors propagate immediately — a missing parent dir, permission denial, etc.
 * are not transient and a retry would just delay the failure.
 */
async function openWriterWithRetry(dbPath: string): Promise<WriterDb> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < MAX_OPEN_RETRIES; attempt++) {
    try {
      return openWriter(dbPath, { loadVec: false });
    } catch (err) {
      lastErr = err;
      const message = err instanceof Error ? err.message : String(err);
      const isContention = /writer already open/i.test(message);
      if (!isContention) throw err;
      if (attempt < MAX_OPEN_RETRIES - 1) {
        await sleep(RETRY_BACKOFF_MS);
      }
    }
  }
  throw new WriterContentionError(dbPath, MAX_OPEN_RETRIES);
}

/**
 * Resolve (lazily open) the cached writer for `dbPath`. If the cached handle
 * was closed externally — e.g., by a test calling `_resetWriterRegistry` —
 * drop the stale entry and re-open. Bootstrap runs once per fresh handle
 * (idempotent, but cheap to skip on the hot path).
 *
 * Concurrent first-callers race here: the §08 writerRegistry would reject
 * every caller after the first if they each invoked openWriter directly. We
 * dedupe by stashing the first caller's open Promise in `inflightOpens`; all
 * subsequent concurrent callers await the same Promise.
 */
async function ensureWriter(dbPath: string): Promise<WriterCacheEntry> {
  const existing = writerCache.get(dbPath);
  if (existing && existing.db.open) return existing;
  if (existing) {
    // Stale (externally closed) — drop before re-opening.
    writerCache.delete(dbPath);
  }
  const inflight = inflightOpens.get(dbPath);
  if (inflight) return inflight;

  const openPromise = (async (): Promise<WriterCacheEntry> => {
    // Belt-and-suspenders parent-dir creation; openWriter does this too, but
    // running it here keeps the error surface uniform across fresh-repo paths.
    try {
      mkdirSync(dirname(dbPath), { recursive: true });
    } catch {
      /* mkdir is best-effort; openWriter will surface a real failure below */
    }
    const db = await openWriterWithRetry(dbPath);
    // Idempotent — no-op when the schema is current. Lets a standalone
    // MCP-server start (no preceding `lodestone init`) still accept feedback
    // without crashing.
    bootstrap(db);
    const entry: WriterCacheEntry = { db, tail: Promise.resolve() };
    writerCache.set(dbPath, entry);
    return entry;
  })();

  inflightOpens.set(dbPath, openPromise);
  try {
    return await openPromise;
  } finally {
    // Clear the in-flight slot whether the open succeeded or failed; on
    // failure the next caller will retry, on success they will hit the
    // populated writerCache.
    inflightOpens.delete(dbPath);
  }
}

/**
 * Test-only: drop every cached writer and close the underlying handles. Tests
 * call this in afterEach (paired with `_resetWriterRegistry` from the §08
 * store) so each test starts with a clean writer pool.
 */
export function _resetCachedWriters(): void {
  for (const entry of writerCache.values()) {
    if (entry.db.open) {
      try {
        closeDb(entry.db);
      } catch {
        /* best-effort */
      }
    }
  }
  writerCache.clear();
  inflightOpens.clear();
}

/**
 * Cleanup on process exit. `beforeExit` fires when the event loop drains, not
 * on SIGINT/SIGTERM (server.ts handles those via its shutdown hook); both
 * paths converge on closing every writer so SQLite's WAL gets a clean
 * checkpoint. Idempotent — safe to call multiple times.
 */
function closeAllWritersOnExit(): void {
  for (const entry of writerCache.values()) {
    if (entry.db.open) {
      try {
        closeDb(entry.db);
      } catch {
        /* swallow — process is exiting, the OS will reclaim the FD */
      }
    }
  }
  writerCache.clear();
}
process.on("beforeExit", closeAllWritersOnExit);

/**
 * Build the handler bound to a specific options bag. The exported `handler`
 * uses production defaults; tests instantiate their own with a temp cwd.
 *
 * Concurrency contract (v0.1.1): every call appends onto a per-DB-path Promise
 * chain so writes serialize, never racing the §08 writerRegistry. The chain
 * is updated *before* the await so two concurrent callers correctly observe
 * each other's slots — classic awaiter pattern.
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

    let entry: WriterCacheEntry;
    try {
      entry = await ensureWriter(dbPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return wrapErr<FeedbackAck>(`feedback persist failed: ${message}`, LODESTONE_CHANNEL_V0);
    }

    // Serialize writes through the per-path chain. We capture the previous
    // tail, then unconditionally update it to our slot — even if the prior
    // slot rejects, our slot still runs (we swallow the chain's rejection
    // before awaiting). This is the standard async-mutex pattern.
    const previousTail = entry.tail;
    let releaseSlot: () => void = () => {};
    const ourSlot = new Promise<void>((resolve) => {
      releaseSlot = resolve;
    });
    entry.tail = previousTail.then(() => ourSlot, () => ourSlot);

    try {
      // Wait until the previous tail resolves OR rejects; either way, our
      // slot becomes the active writer. The `.catch(() => {})` ensures we
      // don't propagate an upstream failure into our own write.
      await previousTail.catch(() => {});

      let id: number;
      try {
        id = writeFeedback(entry.db, event);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return wrapErr<FeedbackAck>(`feedback persist failed: ${message}`, LODESTONE_CHANNEL_V0);
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
    } finally {
      // Release the next slot in the chain regardless of outcome — a failed
      // write must not stall queued callers behind us.
      releaseSlot();
    }
  };
}

/** Production handler — uses `process.cwd()` and live `Date`. */
export const handler = makeHandler();

/** Re-export the contention error class so tests + downstream tooling can
 * `instanceof`-check it without sniffing message text. */
export { WriterContentionError };

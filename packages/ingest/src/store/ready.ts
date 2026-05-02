// SPDX-License-Identifier: Apache-2.0
// Readiness marker (ready.json) - atomic write + read with fsync + rename.
// Consumed by section 13 MCP server on every request to detect mid-ingest
// state and respond with a degraded envelope rather than inconsistent data.

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, existsSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

import type Database from "better-sqlite3";

import { LODESTONE_DIRNAME, parseReadyJson, type ReadyJson } from "@lodestone/shared";

import { getCurrentEpoch, getEmbedderIdentity } from "./index-meta.js";

/** Re-export for callers that prefer importing from the store. */
export type ReadyMarker = ReadyJson;

const READY_FILENAME = "ready.json";

/**
 * Resolve the absolute path of `<lodestoneDir>/ready.json`. Accepts either
 * an explicit `.lodestone/` directory or a project root containing one.
 */
export function readyPath(lodestoneDir: string): string {
  // If the caller passed a project root rather than a `.lodestone/` dir,
  // append the canonical dirname. We detect that by basename.
  const looksLikeLodestoneDir =
    lodestoneDir.endsWith(`/${LODESTONE_DIRNAME}`) ||
    lodestoneDir.endsWith(`\\${LODESTONE_DIRNAME}`) ||
    lodestoneDir === LODESTONE_DIRNAME;
  const dir = looksLikeLodestoneDir ? lodestoneDir : join(lodestoneDir, LODESTONE_DIRNAME);
  return join(dir, READY_FILENAME);
}

/**
 * Read and validate `ready.json`. Returns `null` when the file does not
 * exist (first run / freshly-cleared state). Throws on malformed JSON or a
 * shape that fails Zod validation - both are programmer errors that warrant
 * a clear failure rather than silent degradation.
 */
export function readReady(lodestoneDir: string): ReadyMarker | null {
  const file = readyPath(lodestoneDir);
  if (!existsSync(file)) return null;
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(`Failed to read ${file}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Malformed JSON in ${file}: ${(err as Error).message}. ` +
        `Run \`lodestone reindex --reset\` to rebuild.`,
    );
  }
  return parseReadyJson(parsed);
}

/**
 * Atomically write `ready.json`. Sequence:
 *   1. mkdir -p the parent dir.
 *   2. Open `ready.json.tmp` for write.
 *   3. Write JSON, fsync, close.
 *   4. Rename `.tmp` -> final (atomic on POSIX + NTFS within one filesystem).
 */
export function writeReady(lodestoneDir: string, marker: ReadyMarker): void {
  // Validate shape before writing so callers can't produce a corrupt file.
  parseReadyJson(marker);
  const final = readyPath(lodestoneDir);
  const tmp = `${final}.tmp`;
  mkdirSync(dirname(final), { recursive: true });

  const fd = openSync(tmp, "w", 0o644);
  try {
    const body = `${JSON.stringify(marker, null, 2)}\n`;
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, final);
}

/**
 * Returns the marker if present and `ready: true`. Throws on absence,
 * `ready: false`, or epoch mismatch (when `expectedEpoch` is provided).
 *
 * Section 13 MCP tools call this before every read; on throw they return a
 * degraded envelope to the caller.
 */
export function assertReady(lodestoneDir: string, expectedEpoch?: number): ReadyMarker {
  const marker = readReady(lodestoneDir);
  if (!marker) {
    throw new Error(
      `Lodestone index not ready: no ready.json at ${readyPath(lodestoneDir)}.`,
    );
  }
  if (!marker.ready) {
    throw new Error(`Lodestone index not ready: ready.json reports ready=false.`);
  }
  if (typeof expectedEpoch === "number" && marker.index_epoch !== expectedEpoch) {
    throw new Error(
      `Lodestone index epoch mismatch: ready.json=${marker.index_epoch}, expected=${expectedEpoch}.`,
    );
  }
  return marker;
}

/**
 * Cross-store ready check (Codex impl-008 RED #1 fixup). Verifies that:
 *   1. `ready.json` exists and reports `ready: true`
 *   2. `ready.json.index_epoch` equals `index_meta.current_epoch` from the DB
 *
 * The second check is the load-bearing one: a crash between the SQLite epoch
 * commit and the `ready.json` rename would otherwise leave a stale-but-true
 * marker pointing at uncommitted data, OR a fresh ready.json pointing at an
 * epoch the DB never reached. ready.json and SQLite must agree before we
 * serve a read.
 *
 * Databases that predate migration 002 (no `index_meta` table) are treated
 * as DB epoch = 0; any `ready.json.index_epoch > 0` mismatches — a
 * deliberately strict failure that forces the operator to reindex.
 */
export function assertReaderReady(
  db: Database.Database,
  lodestoneDir: string,
): ReadyMarker {
  const marker = assertReady(lodestoneDir);
  // Legacy-DB shim: when the pipeline has not stamped an embedder identity
  // into `index_meta` (every field is NULL), the DB epoch is 0 by default,
  // which would falsely mismatch a ready.json that records a real epoch.
  // Fall back to the marker-only check in that case. As soon as ANY pipeline
  // pass writes an embedder identity (the production path always does), the
  // strict cross-store check kicks in and catches the crash window.
  const identity = getEmbedderIdentity(db);
  if (identity === null) {
    return marker;
  }
  const dbEpoch = getCurrentEpoch(db);
  if (dbEpoch !== marker.index_epoch) {
    throw new Error(
      `Lodestone index epoch mismatch: ready.json=${marker.index_epoch}, ` +
        `index_meta.current_epoch=${dbEpoch}. ` +
        `An ingest pass crashed mid-write or ready.json is stale — ` +
        `run \`lodestone reindex\` to recover.`,
    );
  }
  return marker;
}

// SPDX-License-Identifier: Apache-2.0
// `recent_changes` tool — §14 implementation. Returns the symbols most
// recently touched, ordered by `symbols.updated_at_epoch` desc. The
// `updated_at_epoch` column is a monotonic counter set on every successful
// ingest pass (see `SymbolWriteContext.index_epoch` in §08), NOT a unix
// timestamp — so the optional `since` filter is best-effort in v0: present
// + non-empty triggers a `warnings` entry that documents the limitation,
// then we still return the freshest top-K so the caller has signal.
//
// POST-CODEX-001 amendment 2: shell-out to `git log` is intentionally
// avoided — the description on the §13 stub already advertises "no shell-out
// to git on the request path" and the SQLite column is the authoritative
// source. Joining git's wall-clock view is a §15+ enhancement.

import { z } from "zod";

import type {
  Diagnostics,
  Language,
  Provenance,
  SymbolKind,
} from "@lodestone/shared";

import {
  LODESTONE_CHANNEL_V0,
  emptyDiagnostics,
  wrapErr,
  wrapNotReady,
  wrapOk,
  type LodestoneToolResponseV13,
} from "../envelope.js";
import { openReader, type SqliteReadonlyDb } from "../client/sqlite.js";
import { provenanceFromReady, resolveCwd, resolveDbPath } from "./_shared.js";

export const description =
  "List symbols (functions, methods, classes) most recently touched by git commits in the project. Optional ISO-8601 `since` filter narrows to a time window; default top_k=20 returns the freshest changes. Useful when the agent needs to orient on what just changed before answering a question, debugging a regression, or summarizing the day's work. Reads from the SQLite `symbols.updated_at_commit` index — no shell-out to git on the request path.";

/** Public schema kept identical to the §13 stub. */
export const inputSchema = z.object({
  since: z.string().optional(),
  top_k: z.number().int().min(1).max(50).default(20),
  channel: z.literal("code").optional(),
});

export type RecentChangesInput = z.infer<typeof inputSchema>;

/** Permissive schema that allows top_k > 50 so we can clamp + report it via
 * `diagnostics.clamped` per POST-CODEX-001 amendment 4. */
const permissiveSchema = z.object({
  since: z.string().optional(),
  top_k: z.number().int().min(1).default(20),
  channel: z.literal("code").optional(),
});

const TOP_K_HARD_CAP = 50;

/** A single recent-change entry. Per the §13 stub description ("List
 * symbols ..."), this is symbol-granularity, not the per-file `ChangeBucket`
 * shape from claude-plan.md — the symbol-level surface is what the description
 * advertises and what the agent UX wants. */
export interface RecentChangedSymbol {
  symbol: string;
  path: string;
  kind: SymbolKind;
  language: Language;
  range: { start_line: number; end_line: number };
  /** Cluster pointer, when known. */
  cluster_id: string | null;
  /** Last commit that touched this symbol — `null` for non-git repos. */
  updated_at_commit: string | null;
  /** Monotonic ingest counter; higher = more recent. */
  updated_at_epoch: number;
  /** Human-readable one-liner describing the symbol's signature, when known. */
  summary: string;
}

interface SymbolRowSlim {
  id: string;
  path: string;
  language: Language;
  kind: SymbolKind;
  range_start_line: number;
  range_end_line: number;
  signature: string | null;
  cluster_id: string | null;
  updated_at_commit: string | null;
  updated_at_epoch: number;
}

export async function handler(
  input: unknown,
): Promise<LodestoneToolResponseV13<RecentChangedSymbol>> {
  let parsed: z.infer<typeof permissiveSchema>;
  try {
    parsed = permissiveSchema.parse(input ?? {});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return wrapErr<RecentChangedSymbol>(message, LODESTONE_CHANNEL_V0);
  }

  let clamped = false;
  let topK = parsed.top_k;
  if (topK > TOP_K_HARD_CAP) {
    topK = TOP_K_HARD_CAP;
    clamped = true;
  }

  // POST-§20 Issue B: `resolveDbPath` honors LODESTONE_DB_PATH > LODESTONE_CWD
  // > process.cwd(). The lodestone dir continues to track resolveCwd() since
  // ready.json lives under <cwd>/.lodestone/ alongside the DB by convention.
  const cwd = resolveCwd();
  const lodestoneDir = `${cwd.replace(/\/$/, "")}/.lodestone`;
  const dbPath = resolveDbPath();

  let handle: ReturnType<typeof openReader>;
  try {
    handle = openReader(dbPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return wrapErr<RecentChangedSymbol>(message, LODESTONE_CHANNEL_V0);
  }

  try {
    let provenance: Provenance | undefined;
    try {
      const marker = handle.ensureReady(lodestoneDir);
      provenance = provenanceFromReady(marker);
    } catch {
      return wrapNotReady<RecentChangedSymbol>(LODESTONE_CHANNEL_V0);
    }

    const rows = fetchRecentSymbols(handle.db, topK);
    const results: RecentChangedSymbol[] = rows.map((r) => ({
      symbol: r.id,
      path: r.path,
      kind: r.kind,
      language: r.language,
      range: { start_line: r.range_start_line, end_line: r.range_end_line },
      cluster_id: r.cluster_id,
      updated_at_commit: r.updated_at_commit,
      updated_at_epoch: r.updated_at_epoch,
      summary: r.signature ?? `${r.kind} ${r.id}`,
    }));

    const diagnostics: Diagnostics = {
      ...emptyDiagnostics(),
      coverage: 1,
    };
    if (clamped) diagnostics.clamped = true;
    if (parsed.since && parsed.since.length > 0) {
      // Document the v0 limitation rather than silently dropping the field.
      diagnostics.warnings = [
        ...(diagnostics.warnings ?? []),
        "since filter is best-effort in v0: symbols.updated_at_epoch is a monotonic counter, not a unix timestamp",
      ];
    }

    return wrapOk<RecentChangedSymbol>(results, LODESTONE_CHANNEL_V0, {
      diagnostics,
      provenance,
    });
  } finally {
    handle.close();
  }
}

/** Pull the top-K symbols by descending `updated_at_epoch`. Ties broken by
 * `id ASC` for stable ordering across calls. */
function fetchRecentSymbols(db: SqliteReadonlyDb, limit: number): SymbolRowSlim[] {
  return db
    .prepare(
      `SELECT
         id,
         path,
         language,
         kind,
         range_start_line,
         range_end_line,
         signature,
         cluster_id,
         updated_at_commit,
         updated_at_epoch
       FROM symbols
       ORDER BY updated_at_epoch DESC, id ASC
       LIMIT ?`,
    )
    .all(limit) as SymbolRowSlim[];
}

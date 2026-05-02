// SPDX-License-Identifier: Apache-2.0
// `skills_for` tool — §16 implementation. ★ moat tool: returns
// codebase-specific skill cards ("this codebase does X this way") that the
// agent should consult before writing code in a given area.
//
// Resolution path (POST-CODEX-001 amendment shape):
//   1. Embed the task_description via §05 embedder.
//   2. In-process cosine similarity over `skills.description_embedding` BLOBs
//      (skills table is small N — Lodestone v0 caps emerging skills at the
//      cluster cardinality, plus a handful of seed skills).
//   3. Rank by score desc; honor top_k (default 5, hard cap 20 — silently
//      clamp to 20 + diagnostics.clamped=true).
//   4. If ALL returned skills are deterministic_seed, prepend a diagnostics
//      warning so the agent caveats appropriately.
//   5. If no skill rows have an embedding yet, fall back to substring match
//      on description.
//   6. Empty result is success — return `{ results: [] }` with a diagnostics
//      warning, never throw.
//
// Each Skill carries `maturity`, `confidence`, `evidence_count`, `observed_days`,
// `body` (full SKILL.md), `emitted_at` ISO timestamp, `match_score` (0..1).
//
// Channel "code" only per POST-FORGE-VISION amendment §2.

import { z } from "zod";

import type { Maturity, Skill, SkillRow } from "@lodestone/shared";
import { lodestoneSubpath } from "@lodestone/shared";
import type { EmbedderHandle } from "@lodestone/ingest/embed";

import {
  LODESTONE_CHANNEL_V0,
  emptyDiagnostics,
  wrapErr,
  wrapNotReady,
  wrapOk,
  type LodestoneToolResponseV13,
} from "../envelope.js";
import { openReader, type ReaderHandle } from "../client/sqlite.js";
import { assertReady, toMcpInputSchema } from "./_shared.js";

export const description =
  "Return the most relevant skill cards for a coding task. Skill cards are codebase-specific patterns Lodestone learned from the project — error-handling conventions, dependency-injection style, testing idioms, naming conventions, lint-preferred imports — surfaced as concise, actionable summaries with example symbol references and a maturity tag (seed | emerging | mature). The agent should consult these BEFORE writing code so its output matches the project's house style. Top_k defaults to 5; semantic match against a task description.";

/**
 * Hard cap on top_k. Per POST-CODEX-001 amendment 4: requests above 20 are
 * silently clamped to 20 with diagnostics.clamped=true (NOT rejected).
 */
const TOP_K_HARD_CAP = 20;

export const inputSchema = z.object({
  task_description: z.string().min(1, "task_description must be non-empty"),
  // Accept any positive int; the handler clamps to TOP_K_HARD_CAP rather than
  // rejecting. The §13 stub schema enforced max(20) — we widen here so the
  // clamping behavior is observable to the agent via diagnostics.clamped.
  top_k: z.number().int().min(1).default(5),
  channel: z.literal("code").optional(),
});

export type SkillsForInput = z.infer<typeof inputSchema>;

/** Pre-computed JSON-Schema-7 view of `inputSchema` for the MCP `tools/list`
 * surface. Pre-compute at module load — see `toMcpInputSchema` JSDoc. */
export const jsonSchema = toMcpInputSchema(inputSchema);

/**
 * Pluggable dependencies. The default handler resolves these from
 * cwd + a lazily-loaded embedder; tests pass mocks.
 */
export interface SkillsForContext {
  openReader(): ReaderHandle;
  loadEmbedder?: () => Promise<EmbedderHandle>;
}

function defaultContext(): SkillsForContext {
  const cwd = process.cwd();
  const dbPath = lodestoneSubpath(cwd, "sqlite");
  return {
    openReader: () => openReader(dbPath),
    loadEmbedder: async () => {
      const mod = await import("@lodestone/ingest/embed");
      return mod.load();
    },
  };
}

/**
 * Factory that returns a handler bound to a specific context. The exported
 * `handler` uses the default context; tests use this directly with mocks.
 */
export function createHandler(
  ctx: SkillsForContext = defaultContext(),
): (input: unknown) => Promise<LodestoneToolResponseV13<Skill>> {
  return async (raw: unknown) => {
    let parsed: SkillsForInput;
    try {
      parsed = inputSchema.parse(raw);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return wrapErr<Skill>(message, LODESTONE_CHANNEL_V0);
    }

    // Clamp top_k per POST-CODEX-001 amendment 4.
    const requestedTopK = parsed.top_k;
    const clamped = requestedTopK > TOP_K_HARD_CAP;
    const topK = clamped ? TOP_K_HARD_CAP : requestedTopK;

    let reader: ReaderHandle;
    try {
      reader = ctx.openReader();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return wrapErr<Skill>(`failed to open lodestone index: ${message}`, LODESTONE_CHANNEL_V0);
    }

    const warnings: string[] = [];
    if (clamped) {
      warnings.push(
        `top_k=${requestedTopK} exceeds hard cap; clamped to ${TOP_K_HARD_CAP}`,
      );
    }

    try {
      // impl-008 RED #4 cross-cut.
      try {
        assertReady(reader);
      } catch {
        return wrapNotReady<Skill>(LODESTONE_CHANNEL_V0);
      }

      const allRows = reader.db
        .prepare("SELECT * FROM skills")
        .all() as SkillRow[];

      if (allRows.length === 0) {
        warnings.push(
          "no skills emitted yet (run lodestone seed or wait for the watcher to observe a stable cluster)",
        );
        return wrapOk<Skill>([], LODESTONE_CHANNEL_V0, {
          diagnostics: { ...emptyDiagnostics(), warnings, ...(clamped ? { clamped: true } : {}) },
        });
      }

      const ranked = await rankSkills(
        allRows,
        parsed.task_description,
        ctx.loadEmbedder,
        warnings,
      );

      const top = ranked.slice(0, topK);
      const results: Skill[] = top.map(({ row, score }) => skillFromRow(row, score));

      // Honesty diagnostic per POST-CODEX-001 amendment 3: if every returned
      // skill is deterministic_seed, the index has not yet observed enough.
      if (
        results.length > 0 &&
        results.every((s) => s.maturity === "deterministic_seed")
      ) {
        warnings.push(
          "all results are deterministic_seed; index has not yet observed enough to surface emerging patterns",
        );
      }

      if (results.length === 0) {
        warnings.push(
          `no skills matched "${parsed.task_description}"`,
        );
      }

      const diagnostics = {
        ...emptyDiagnostics(),
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(clamped ? { clamped: true } : {}),
      };

      return wrapOk<Skill>(results, LODESTONE_CHANNEL_V0, { diagnostics });
    } finally {
      reader.close();
    }
  };
}

/** Default handler — uses the cwd-resolved context. */
export const handler = createHandler();

/* ------------------------------------------------------------------------- */
/* Internals                                                                 */
/* ------------------------------------------------------------------------- */

interface RankedSkill {
  row: SkillRow;
  score: number;
}

/**
 * Rank skills by cosine similarity to the embedded task description.
 * Falls back to substring scoring if embedding is unavailable.
 */
async function rankSkills(
  rows: SkillRow[],
  query: string,
  loadEmbedder: SkillsForContext["loadEmbedder"],
  warnings: string[],
): Promise<RankedSkill[]> {
  const withEmbeddings = rows.filter(
    (r) => r.description_embedding !== null && r.description_embedding !== undefined,
  );

  if (withEmbeddings.length === 0 || !loadEmbedder) {
    warnings.push(
      "skill description embeddings not yet computed; falling back to substring scoring",
    );
    return substringRank(rows, query);
  }

  let embedder: EmbedderHandle;
  try {
    embedder = await loadEmbedder();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warnings.push(
      `embedder unavailable (${message}); falling back to substring scoring`,
    );
    return substringRank(rows, query);
  }

  let queryVec: Float32Array;
  try {
    const out = await embedder.embed([query]);
    queryVec = out[0]!;
  } finally {
    await embedder.dispose().catch(() => {
      /* idempotent + best-effort */
    });
  }

  const scored: RankedSkill[] = [];
  for (const row of withEmbeddings) {
    const vec = bufferToFloat32(row.description_embedding!);
    if (vec.length !== queryVec.length) continue; // dim mismatch — skip
    let dot = 0;
    for (let i = 0; i < queryVec.length; i += 1) {
      dot += queryVec[i]! * vec[i]!;
    }
    // Vectors are L2-normalized, so dot ∈ [-1, 1]. Map to [0, 1].
    const cosine01 = (dot + 1) / 2;
    scored.push({ row, score: cosine01 });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * Substring-based fallback ranking when embeddings are missing. Score is the
 * fraction of query tokens that appear in the description (lower-cased,
 * naïve whitespace split). Coarse, but lets the tool stay useful at install
 * time before the embedder pass has run.
 */
function substringRank(rows: SkillRow[], query: string): RankedSkill[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const scored: RankedSkill[] = [];
  for (const row of rows) {
    const haystack = `${row.name} ${row.description}`.toLowerCase();
    let hits = 0;
    for (const t of tokens) {
      if (haystack.includes(t)) hits += 1;
    }
    if (hits === 0) continue;
    scored.push({ row, score: hits / tokens.length });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/** Reinterpret an SQLite BLOB as a Float32Array (alignment-safe copy). */
function bufferToFloat32(buf: Buffer): Float32Array {
  const out = new Float32Array(buf.byteLength / 4);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = view.getFloat32(i * 4, true);
  }
  return out;
}

/** Build the application-level Skill from a SkillRow + match score. */
function skillFromRow(row: SkillRow, matchScore: number): Skill {
  const skill: Skill = {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    body: row.body,
    maturity: row.maturity as Maturity,
    confidence: row.confidence,
    evidence_count: row.evidence_count,
    observed_days: row.observed_days,
    emitted_at: row.emitted_at,
    match_score: matchScore,
  };
  if (row.source_cluster_id) {
    skill.source_cluster_id = row.source_cluster_id;
  }
  return skill;
}

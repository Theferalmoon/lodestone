// SPDX-License-Identifier: Apache-2.0
// Lodestone — pipeline-side helpers that drive batch emission of SKILL.md
// cards to disk for both cluster-derived ("emerging"/"observed") skills and
// the deterministic seed skills produced by §11.
//
// Codex v0.1.1 §10 YELLOW: prior to this module the pipeline only persisted
// cluster + seed skills to SQLite via writeSkills() — no on-disk SKILL.md
// cards were emitted outside test harnesses. The emit() path was wired but
// only exercised in unit tests. This module is the production caller.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

import type Database from "better-sqlite3";

import type { Cluster, Skill } from "@lodestone/shared";

import type { EmbedderHandle } from "../embed/runtime.js";

import { emit, type EmitConfig, type EmitResult, type EmitSource } from "./emit.js";
import { renderFrontmatter, type FrontmatterFields } from "./frontmatter.js";
import { slugify } from "./slug.js";

export interface EmitClusterSkillsOptions {
  /** Absolute path to the `.lodestone/` directory. */
  lodestoneDir: string;
  /** SQLite handle — clusters are mirrored to the `skills` table on every emit. */
  db: Database.Database;
  /**
   * Pipeline runs are first-time clusterings; the in-memory Cluster shape has
   * no `created_at`. Pass `now` explicitly so tests can pin timestamps.
   */
  now?: Date;
  /**
   * Override the selection thresholds. The pipeline default disables the
   * `minAgeDays` check (set to 0) because v0 does not yet persist cluster
   * creation epochs across runs — without this override every fresh-run
   * cluster would be rejected as `too_young`. Future revisions that thread
   * cluster epoch into ClusterRow can drop the override.
   */
  selection?: EmitConfig["selection"];
  /**
   * Codex r2 §10 NEW RED: forward the pipeline's embedder so the cluster
   * card's `skills.description_embedding` column is populated. Mirrors the
   * seed-skill path at pipeline/index.ts:315-323 (writeSkills(..., {embedder}))
   * — without this, cluster skills are invisible to §16 cosine search and
   * fall through to lexical fallback only.
   */
  embedder?: EmbedderHandle;
}

export interface EmitClusterSkillsResult {
  /** Number of clusters whose SKILL.md was newly written or rewritten. */
  written: number;
  /** Number of clusters whose SKILL.md was already up-to-date (no rewrite). */
  unchanged: number;
  /** Number of clusters that failed the `selection.shouldEmit` gate. */
  rejected: number;
  /** Per-cluster outcomes, useful for telemetry / tests. */
  outcomes: Array<{ clusterId: string; result: EmitResult }>;
}

/**
 * Emit a SKILL.md card for every cluster that passes selection. Mirrors each
 * accepted cluster into the SQLite `skills` table via the `db` handle the
 * pipeline already opens for cluster persistence.
 *
 * Failures on individual clusters are swallowed (logged into the outcome list
 * with a synthetic `selection_rejected`/error result) so a single bad cluster
 * cannot abort the whole pipeline.
 */
export async function emitClusterSkills(
  clusters: readonly Cluster[],
  opts: EmitClusterSkillsOptions,
): Promise<EmitClusterSkillsResult> {
  const now = opts.now ?? new Date();
  const selection = opts.selection ?? { minAgeDays: 0 };
  let written = 0;
  let unchanged = 0;
  let rejected = 0;
  const outcomes: EmitClusterSkillsResult["outcomes"] = [];

  for (const cluster of clusters) {
    let result: EmitResult;
    try {
      result = await emit(cluster, {
        lodestoneDir: opts.lodestoneDir,
        db: opts.db,
        now,
        selection,
        embedder: opts.embedder,
      });
    } catch (err) {
      // Swallow per-cluster failures — pipeline must keep moving (§0
      // uptime). Surface in the outcome list so callers can audit.
      result = {
        written: false,
        reason: "selection_rejected",
        decision_reason: `error:${err instanceof Error ? err.message : String(err)}`,
      };
    }
    outcomes.push({ clusterId: cluster.id, result });
    if (result.written) written++;
    else if (result.reason === "unchanged") unchanged++;
    else rejected++;
  }

  return { written, unchanged, rejected, outcomes };
}

export interface EmitSeedSkillFilesResult {
  /** Number of seed SKILL.md files newly written or rewritten. */
  written: number;
  /** Number of seed SKILL.md files already up-to-date. */
  unchanged: number;
  /** Per-skill outcome paths. */
  paths: string[];
}

/**
 * Codex v0.1.1 §11 YELLOW: seed skills produced by `seedSkillsFor()` were
 * persisted to the SQLite `skills` table by the pipeline but never written
 * out as `.lodestone/skills/seed/<slug>/SKILL.md` files. This helper closes
 * that gap: it renders each seed Skill into the same frontmatter+body shape
 * the §10 emitter uses (so consumers get a uniform on-disk format) and
 * writes atomically with SHA-based idempotency.
 *
 * Note: we do NOT route through `emit()` because it expects a Cluster, not a
 * Skill. The frontmatter shape is identical though — same FrontmatterFields,
 * same atomic-rename semantics, same SHA gating.
 */
export async function emitSeedSkillFiles(
  skills: readonly Skill[],
  lodestoneDir: string,
): Promise<EmitSeedSkillFilesResult> {
  let written = 0;
  let unchanged = 0;
  const paths: string[] = [];

  for (const skill of skills) {
    const slug = skill.slug || slugify(skill.name, skill.id);
    const dir = path.join(lodestoneDir, "skills", "seed", slug);
    const file = path.join(dir, "SKILL.md");
    const body = skill.body;
    const sha256 = sha256Hex(body);

    // Idempotency: parse existing frontmatter and skip if both stored hash
    // and on-disk body hash match (mirrors the §10 fix from RED #1).
    const existing = await readIfExists(file);
    if (existing) {
      const fm = parseExistingHash(existing);
      const bodyText = stripFrontmatter(existing);
      const onDiskBodySha = sha256Hex(bodyText);
      if (fm === sha256 && onDiskBodySha === sha256) {
        unchanged++;
        paths.push(file);
        continue;
      }
    }

    const fmFields: FrontmatterFields = {
      id: skill.id,
      slug,
      name: skill.name,
      description: skill.description,
      source: "seed",
      source_cluster_id: skill.source_cluster_id,
      emitted_at: skill.emitted_at,
      content_sha256: sha256,
      member_count: skill.evidence_count,
      top_symbols: [],
      confidence: skill.confidence,
      observed_days: skill.observed_days,
      evidence_count: skill.evidence_count,
    };
    const text = `${renderFrontmatter(fmFields)}${body}`;

    await mkdir(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, text, "utf8");
    await rename(tmp, file);
    written++;
    paths.push(file);
  }

  return { written, unchanged, paths };
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

const FENCE = "---";

/** Extract `content_sha256` from existing frontmatter without full YAML parse. */
function parseExistingHash(text: string): string | null {
  if (!text.startsWith(`${FENCE}\n`)) return null;
  const close = text.indexOf(`\n${FENCE}`, FENCE.length);
  if (close < 0) return null;
  const block = text.slice(FENCE.length + 1, close);
  const m = /^content_sha256:\s*([0-9a-f]+)\s*$/m.exec(block);
  return m ? m[1]! : null;
}

function stripFrontmatter(text: string): string {
  if (!text.startsWith(`${FENCE}\n`)) return text;
  const close = text.indexOf(`\n${FENCE}`, FENCE.length);
  if (close < 0) return text;
  let body = text.slice(close + 1 + FENCE.length);
  if (body.startsWith("\n")) body = body.slice(1);
  return body;
}

// Re-export so the barrel can pass the type through cleanly.
export type { EmitSource };

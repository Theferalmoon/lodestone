// SPDX-License-Identifier: Apache-2.0
// Lodestone — convert a Cluster into an idempotent SKILL.md (and a `skills`
// table row) on disk and in SQLite.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type Database from "better-sqlite3";

import type { Cluster, Maturity, Skill } from "@lodestone/shared";

import {
  computeConfidence,
  confidenceInputsFromCluster,
  observedDaysFrom,
} from "./confidence.js";
import {
  type FrontmatterFields,
  parseFrontmatter,
  renderFrontmatter,
  sourceToMaturity,
} from "./frontmatter.js";
import { writeSkill } from "./persist.js";
import { shouldEmit, type SelectionConfig } from "./selection.js";
import { slugify } from "./slug.js";
import { renderBody } from "./template.js";

const TOP_SYMBOLS_LIMIT = 10;
const OBSERVED_THRESHOLD_DAYS = 30;

export type EmitSource = "seed" | "emerging" | "observed";

export interface EmitConfig {
  /** Absolute path to the `.lodestone/` directory. */
  lodestoneDir: string;
  /** Override the source label that lands in the frontmatter. */
  source?: EmitSource;
  /** Selection thresholds; defaults applied per `selection.ts`. */
  selection?: SelectionConfig;
  /** Override `now` for deterministic tests. */
  now?: Date;
  /** ISO-8601 cluster `created_at`; if absent we fall back to 0 observed days. */
  createdAt?: string;
  /** Optional SQLite handle. When supplied we also persist to the `skills` table. */
  db?: Database.Database;
  /** Stable id; generated when omitted. */
  id?: string;
}

export type EmitResult =
  | { written: true; path: string; sha256: string; skill: Skill }
  | {
      written: false;
      reason: "unchanged" | "selection_rejected";
      path?: string;
      decision_reason?: string;
    };

/**
 * Render and write a SKILL.md for `cluster`, idempotently.
 *
 * Disk layout (per spec §10):
 *   <lodestoneDir>/skills/<source>/<slug>/SKILL.md
 *
 * Idempotency: the rendered body's SHA256 is stored in the frontmatter's
 * `content_sha256`. When the existing on-disk file's SHA matches the
 * recomputed SHA, no write happens (the file's mtime is preserved).
 *
 * When `cfg.db` is supplied we additionally upsert into the `skills` table
 * (POST-CODEX-001 amendment: SQLite is the source of truth for the MCP
 * `skills_for()` tool).
 */
export async function emit(cluster: Cluster, cfg: EmitConfig): Promise<EmitResult> {
  const now = cfg.now ?? new Date();
  const observedDays = observedDaysFrom(cfg.createdAt, now);

  const decision = shouldEmit(cluster, { observedDays }, cfg.selection ?? {});
  if (!decision.emit) {
    return {
      written: false,
      reason: "selection_rejected",
      decision_reason: decision.reason,
    };
  }

  const source: EmitSource =
    cfg.source ?? (observedDays >= OBSERVED_THRESHOLD_DAYS ? "observed" : "emerging");
  const slug = slugify(cluster.name, cluster.id);
  const dir = path.join(cfg.lodestoneDir, "skills", source, slug);
  const file = path.join(dir, "SKILL.md");
  const id = cfg.id ?? randomUUID();

  const body = renderBody(cluster);
  const sha256 = sha256Hex(body);

  // Idempotency check: read existing frontmatter (if any) and compare SHAs.
  const existing = await readIfExists(file);
  if (existing) {
    const parsed = parseFrontmatter(existing);
    if (parsed && parsed.fields.content_sha256 === sha256) {
      // Even when the disk file is unchanged, mirror to SQLite when supplied
      // — this lets a re-run pick up a freshly bootstrapped DB without
      // forcing a disk rewrite.
      if (cfg.db) {
        const skill = buildSkill(parsed.fields, body, cluster, source, observedDays);
        writeSkill(cfg.db, skill, { body_sha256: sha256 });
      }
      return { written: false, reason: "unchanged", path: file };
    }
  }

  const confidence = computeConfidence(confidenceInputsFromCluster(cluster, observedDays));

  const frontmatter: FrontmatterFields = {
    id,
    slug,
    name: cluster.name,
    description: cluster.description,
    source,
    source_cluster_id: cluster.id,
    emitted_at: now.toISOString(),
    content_sha256: sha256,
    member_count: cluster.size,
    top_symbols: cluster.members.slice(0, TOP_SYMBOLS_LIMIT).map((m) => m.symbol),
    confidence,
    observed_days: observedDays,
    evidence_count: cluster.size,
  };

  const text = `${renderFrontmatter(frontmatter)}${body}`;

  // Atomic write: write tmp + rename.
  await mkdir(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, file);

  const skill = buildSkill(frontmatter, body, cluster, source, observedDays);
  if (cfg.db) {
    writeSkill(cfg.db, skill, { body_sha256: sha256 });
  }

  return { written: true, path: file, sha256, skill };
}

function buildSkill(
  fm: FrontmatterFields,
  body: string,
  cluster: Cluster,
  source: EmitSource,
  observedDays: number,
): Skill {
  const maturity: Maturity = sourceToMaturity(source);
  return {
    id: fm.id,
    slug: fm.slug,
    name: fm.name,
    description: fm.description,
    body,
    source_cluster_id: cluster.id,
    maturity,
    confidence: fm.confidence,
    evidence_count: fm.evidence_count,
    observed_days: observedDays,
    emitted_at: fm.emitted_at,
  };
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

export { sha256Hex };

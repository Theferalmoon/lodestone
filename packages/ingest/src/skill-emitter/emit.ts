// SPDX-License-Identifier: Apache-2.0
// Lodestone — convert a Cluster into an idempotent SKILL.md (and a `skills`
// table row) on disk and in SQLite.

import { createHash } from "node:crypto";
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
import type { EmbedderHandle } from "../embed/runtime.js";

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
  /**
   * Codex r2 §10 NEW RED: when supplied, embed the cluster's description and
   * persist it as `skills.description_embedding` so §16 `skills_for` cosine
   * search can rank the emitted cluster card. Without this, cluster cards
   * land in SQLite with NULL embeddings and only show up via lexical
   * fallback. The seed-skill path at pipeline/index.ts:315-323 already wires
   * the embedder via writeSkills(); this brings the cluster path to parity.
   */
  embedder?: EmbedderHandle;
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

  const body = renderBody(cluster);
  const sha256 = sha256Hex(body);

  // Idempotency check: read existing frontmatter (if any) and compare SHAs.
  // Codex v0.1.1 §10 RED #1 + YELLOW: id stability across content changes
  // requires reusing the existing frontmatter id. Body-idempotency YELLOW
  // requires comparing the recomputed body SHA against BOTH the stored
  // `content_sha256` AND the actual on-disk body SHA (a friend may have
  // edited the body without updating frontmatter).
  const existing = await readIfExists(file);
  let existingId: string | undefined;
  if (existing) {
    const parsed = parseFrontmatter(existing);
    if (parsed) {
      existingId = parsed.fields.id;
      const onDiskBodySha = sha256Hex(parsed.body);
      // Treat as unchanged ONLY when both the stored hash matches the new
      // body AND the on-disk body actually matches that stored hash. This
      // catches the "frontmatter says X but body has been hand-edited" case.
      if (parsed.fields.content_sha256 === sha256 && onDiskBodySha === sha256) {
        // Even when the disk file is unchanged, mirror to SQLite when supplied
        // — this lets a re-run pick up a freshly bootstrapped DB without
        // forcing a disk rewrite.
        if (cfg.db) {
          const skill = buildSkill(parsed.fields, body, cluster, source, observedDays);
          // Codex r2 §10 NEW RED: also embed the description on the unchanged
          // path so a re-run with a freshly-attached embedder can backfill a
          // NULL description_embedding column without forcing a disk rewrite.
          const embeddingBuf = await embedDescription(cfg.embedder, skill.description);
          writeSkill(cfg.db, skill, {
            body_sha256: sha256,
            description_embedding: embeddingBuf,
          });
        }
        return { written: false, reason: "unchanged", path: file };
      }
    }
  }

  // ID resolution order (RED #1):
  //   1. Existing frontmatter id (preserves identity across body updates).
  //   2. Explicit cfg.id from caller (test seam + override hook).
  //   3. Deterministic id derived from a content-stable signature
  //      (cluster.id + source + slug — mirrors the v0.1.1 anchor-based
  //      stableClusterId pattern; never randomUUID).
  const id = existingId ?? cfg.id ?? deriveStableSkillId(cluster.id, source, slug);

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
    // Codex r2 §10 NEW RED: embed description so the row in `skills` carries a
    // populated `description_embedding` and is rankable by §16 cosine search.
    const embeddingBuf = await embedDescription(cfg.embedder, skill.description);
    writeSkill(cfg.db, skill, {
      body_sha256: sha256,
      description_embedding: embeddingBuf,
    });
  }

  return { written: true, path: file, sha256, skill };
}

/**
 * Codex r2 §10 NEW RED helper. Returns a Buffer wrapping the Float32Array
 * bytes of the description embedding when an embedder is supplied; null
 * otherwise (preserves the pre-r2 column-NULL behaviour for callers without
 * an embedder, e.g. tests + the §11 CLI seed-skills command).
 *
 * Embedder failure is best-effort: a thrown embedder reverts to NULL rather
 * than aborting the whole pipeline (§0 uptime). The §16 reader degrades to
 * lexical scoring on NULL, which is the same as the pre-r2 behaviour.
 */
async function embedDescription(
  embedder: EmbedderHandle | undefined,
  description: string,
): Promise<Buffer | null> {
  if (!embedder) return null;
  try {
    const [vec] = await embedder.embed([description]);
    if (!vec) return null;
    return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
  } catch {
    return null;
  }
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

/**
 * Codex v0.1.1 §10 RED #1: derive a stable skill id from content-stable
 * inputs (NOT from the body, which can shift run-to-run). The signature is
 * `${source}|${cluster.id}|${slug}` — same cluster identity, same skill id,
 * regardless of body churn from member/bridge order tweaks. Formatted as a
 * UUIDv5-ish 36-char string so existing UUID consumers don't break.
 */
function deriveStableSkillId(clusterId: string, source: EmitSource, slug: string): string {
  const sig = `lodestone-skill-id|${source}|${clusterId}|${slug}`;
  const digest = createHash("sha256").update(sig, "utf8").digest("hex");
  // 8-4-4-4-12 hyphenation; not a true UUIDv5 but a stable, opaque token of
  // the same shape. Identity is content-determined; collisions across
  // different (source, clusterId, slug) triples are cryptographically
  // negligible.
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    digest.slice(12, 16),
    digest.slice(16, 20),
    digest.slice(20, 32),
  ].join("-");
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

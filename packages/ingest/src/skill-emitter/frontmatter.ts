// SPDX-License-Identifier: Apache-2.0
// Lodestone — YAML frontmatter render + parse for SKILL.md.

import { parse as yamlParse, stringify as yamlStringify } from "yaml";

import type { Maturity } from "@lodestone/shared";

export interface FrontmatterFields {
  id: string;
  slug: string;
  name: string;
  description: string;
  /**
   * POST-CODEX-001: SKILL.md frontmatter still uses the human-readable `source`
   * label (`"seed"` or `"emerging"`/`"observed"`) for git-friendly diffs. The
   * SQLite source-of-truth carries the full `Maturity` enum on the `skills`
   * row's `maturity` column.
   */
  source: "seed" | "emerging" | "observed";
  source_cluster_id?: string;
  emitted_at: string;
  content_sha256: string;
  member_count: number;
  top_symbols: string[];
  /** 0..1 confidence value carried forward to consumers ranking emerging skills. */
  confidence: number;
  /** Cluster age in days (0 for seed). */
  observed_days: number;
  /** Files / sites that informed this skill. */
  evidence_count: number;
}

const FENCE = "---";

/**
 * Render the frontmatter block (including the leading + trailing `---`
 * fences and a trailing newline). Field order is fixed for deterministic
 * disk diffs and snapshot stability.
 */
export function renderFrontmatter(f: FrontmatterFields): string {
  const ordered: Record<string, unknown> = {
    id: f.id,
    slug: f.slug,
    name: f.name,
    description: f.description,
    source: f.source,
  };
  if (f.source_cluster_id !== undefined) {
    ordered.source_cluster_id = f.source_cluster_id;
  }
  ordered.emitted_at = f.emitted_at;
  ordered.content_sha256 = f.content_sha256;
  ordered.member_count = f.member_count;
  ordered.confidence = f.confidence;
  ordered.observed_days = f.observed_days;
  ordered.evidence_count = f.evidence_count;
  ordered.top_symbols = f.top_symbols;

  // `yaml` lib's stringify already emits `\n` per line; trim trailing newline
  // before re-wrapping so we control exactly one separator.
  const body = yamlStringify(ordered, { lineWidth: 0 }).replace(/\n+$/, "");
  return `${FENCE}\n${body}\n${FENCE}\n`;
}

/**
 * Parse an existing SKILL.md text. Returns `null` if the leading `---`
 * fence is missing or the YAML inside is malformed.
 */
export function parseFrontmatter(
  text: string,
): { fields: FrontmatterFields; body: string } | null {
  if (!text.startsWith(`${FENCE}\n`) && !text.startsWith(`${FENCE}\r\n`)) {
    return null;
  }
  const afterOpen = text.indexOf(`\n${FENCE}`, FENCE.length);
  if (afterOpen < 0) return null;
  const yamlBlock = text.slice(FENCE.length + 1, afterOpen);
  let parsed: unknown;
  try {
    parsed = yamlParse(yamlBlock);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const fields = parsed as FrontmatterFields;
  // Body sits after the closing fence (which was matched at `afterOpen`)
  // plus the fence string itself plus a single newline.
  const bodyStart = afterOpen + 1 + FENCE.length;
  let body = text.slice(bodyStart);
  if (body.startsWith("\r\n")) body = body.slice(2);
  else if (body.startsWith("\n")) body = body.slice(1);
  return { fields, body };
}

/**
 * Map a frontmatter `source` label to the SQLite `Maturity` enum used on the
 * `skills` row. POST-CODEX-001 distinguishes emerging (<30d) vs observed
 * (≥30d); seed maps directly.
 */
export function sourceToMaturity(source: FrontmatterFields["source"]): Maturity {
  if (source === "seed") return "deterministic_seed";
  if (source === "observed") return "observed";
  return "emerging";
}

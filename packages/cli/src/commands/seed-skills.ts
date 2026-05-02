// SPDX-License-Identifier: Apache-2.0
// `lodestone seed-skills` — Codex v0.1.1 §11 RED #4 fix. Promoted from a
// success-returning stub to a real end-to-end command.
//
// Steps:
//   1. Verify .lodestone/ exists; exit non-zero with a clear "run lodestone
//      init first" message if not.
//   2. Walk the cwd for parser-supported source files.
//   3. Parse each file via the §06 parsers (no DB / embedder dependency —
//      the seed scanners operate on ParseResult[] alone).
//   4. Run every deterministic-seed scanner via seedSkillsFor().
//   5. Render each emitted Skill into .lodestone/skills/seed/<slug>/SKILL.md
//      using the same frontmatter shape the §10 emitter uses (atomic write,
//      SHA-256 idempotency).
//   6. Print a one-line summary.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

import { output } from "../ui/output.js";

interface SeedSkillsArgs {
  /** Future flag: rebuild every card (skip SHA idempotency). v0 honours
   * the field but does not parse it from argv yet. */
  force?: boolean;
}

export async function seedSkills(_argv: readonly string[]): Promise<number> {
  const cwd = process.cwd();
  const lodestoneDir = path.join(cwd, ".lodestone");

  if (!existsSync(lodestoneDir)) {
    output.error(
      ".lodestone/ not found in this directory. Run `lodestone init` first to set up the project.",
    );
    return 1;
  }

  let summary: { written: number; unchanged: number; emitted: number };
  try {
    summary = await runSeedSkills(cwd, lodestoneDir, {});
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    output.error(`seed-skills failed: ${detail}`);
    return 1;
  }

  output.success(
    `seed-skills complete: ${summary.emitted} skill(s) detected; ${summary.written} SKILL.md written, ${summary.unchanged} unchanged.`,
  );
  return 0;
}

/**
 * Library-level entry point. Exposed so unit tests can drive the pipeline
 * without spawning the CLI binary.
 */
export async function runSeedSkills(
  cwd: string,
  lodestoneDir: string,
  _opts: SeedSkillsArgs,
): Promise<{ written: number; unchanged: number; emitted: number }> {
  // Lazy import — keeps the CLI startup cost low and avoids loading
  // tree-sitter / better-sqlite3 native deps when the command is not used.
  const ingest = await import("@lodestone/ingest");
  const parsersMod = (await import("@lodestone/ingest/parsers")) as typeof import(
    "@lodestone/ingest/parsers"
  );
  const { listSourceFiles, seedSkillsFor } = ingest as unknown as {
    listSourceFiles: (root: string) => string[];
    seedSkillsFor: (
      results: ReadonlyArray<{
        symbols: unknown[];
        edges: unknown[];
        class_inheritance: unknown[];
        warnings: string[];
      }>,
      cfg?: { now?: Date },
    ) => Array<{
      id: string;
      slug: string;
      name: string;
      description: string;
      body: string;
      source_cluster_id: string | undefined;
      maturity: string;
      confidence: number;
      evidence_count: number;
      observed_days: number;
      emitted_at: string;
    }>;
  };

  const files = listSourceFiles(cwd);
  type ParseResultLike = {
    symbols: unknown[];
    edges: unknown[];
    class_inheritance: unknown[];
    warnings: string[];
  };
  const parseResults: ParseResultLike[] = [];

  for (const file of files) {
    const parser = parsersMod.parserForFile(file);
    if (!parser) continue;
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    try {
      if (statSync(file).size > 5 * 1024 * 1024) continue;
    } catch {
      /* stat failure -> just try the parse */
    }
    const rel = path.relative(cwd, file);
    let pr: ParseResultLike;
    try {
      pr = (await parser.parse(rel, source)) as ParseResultLike;
    } catch {
      continue;
    }
    parseResults.push(pr);
  }

  const skills = seedSkillsFor(parseResults);
  let written = 0;
  let unchanged = 0;

  for (const skill of skills) {
    const result = await writeSeedSkillFile(skill, lodestoneDir);
    if (result === "written") written++;
    else unchanged++;
  }

  return { written, unchanged, emitted: skills.length };
}

interface SkillLike {
  id: string;
  slug: string;
  name: string;
  description: string;
  body: string;
  source_cluster_id: string | undefined;
  confidence: number;
  evidence_count: number;
  observed_days: number;
  emitted_at: string;
}

const FENCE = "---";

async function writeSeedSkillFile(
  skill: SkillLike,
  lodestoneDir: string,
): Promise<"written" | "unchanged"> {
  const dir = path.join(lodestoneDir, "skills", "seed", skill.slug);
  const file = path.join(dir, "SKILL.md");
  const body = skill.body;
  const sha256 = sha256Hex(body);

  // Idempotency: parse existing frontmatter sha + on-disk body sha; skip
  // when both match the recomputed body sha (mirrors §10 emit RED #1 fix).
  const existing = await readIfExists(file);
  if (existing) {
    const fmSha = parseExistingHash(existing);
    const onDiskBody = stripFrontmatter(existing);
    if (fmSha === sha256 && sha256Hex(onDiskBody) === sha256) {
      return "unchanged";
    }
  }

  const frontmatter = renderFrontmatter({
    id: skill.id,
    slug: skill.slug,
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
  });
  const text = `${frontmatter}${body}`;

  await mkdir(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, file);
  return "written";
}

interface FrontmatterFields {
  id: string;
  slug: string;
  name: string;
  description: string;
  source: "seed" | "emerging" | "observed";
  source_cluster_id?: string;
  emitted_at: string;
  content_sha256: string;
  member_count: number;
  top_symbols: string[];
  confidence: number;
  observed_days: number;
  evidence_count: number;
}

/** Minimal local YAML frontmatter renderer. Mirrors the §10 emitter shape so
 * skills_for() consumers see the same fields regardless of producer. */
function renderFrontmatter(f: FrontmatterFields): string {
  const lines: string[] = [];
  lines.push(`id: ${yamlScalar(f.id)}`);
  lines.push(`slug: ${yamlScalar(f.slug)}`);
  lines.push(`name: ${yamlScalar(f.name)}`);
  lines.push(`description: ${yamlScalar(f.description)}`);
  lines.push(`source: ${f.source}`);
  if (f.source_cluster_id !== undefined) {
    lines.push(`source_cluster_id: ${yamlScalar(f.source_cluster_id)}`);
  }
  lines.push(`emitted_at: ${f.emitted_at}`);
  lines.push(`content_sha256: ${f.content_sha256}`);
  lines.push(`member_count: ${f.member_count}`);
  lines.push(`confidence: ${f.confidence}`);
  lines.push(`observed_days: ${f.observed_days}`);
  lines.push(`evidence_count: ${f.evidence_count}`);
  if (f.top_symbols.length === 0) {
    lines.push(`top_symbols: []`);
  } else {
    lines.push(`top_symbols:`);
    for (const s of f.top_symbols) lines.push(`  - ${yamlScalar(s)}`);
  }
  return `${FENCE}\n${lines.join("\n")}\n${FENCE}\n`;
}

/** Quote a YAML scalar when it contains characters that need escaping. */
function yamlScalar(s: string): string {
  if (/^[A-Za-z0-9._-]+$/.test(s) || /^\d{4}-\d{2}-\d{2}T/.test(s)) return s;
  // Use double quotes + escape backslashes and double quotes.
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
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

// SPDX-License-Identifier: Apache-2.0
// Lodestone — config / env-convention seed-skill scanner.
//
// POST-CODEX-001 §1 amendment to spec §11: added detectConfigEnvPatterns to
// the seed scanner set. Heuristic: walk import edges for known config-style
// modules (dotenv, envalid, viper, pydantic-settings, etc.) AND for project-
// local config-named modules (`./config`, `../config`, `app/config`).
// Conservative ≥2 importers per the rest of §11.

import { createHash } from "node:crypto";

import type { ParseResult } from "../parsers/base.js";

import type { SeedSkillInput, SeedSkillRecord } from "./types.js";

interface ConfigSig {
  display: string;
  /** Module specifiers (or substrings) that indicate this convention. */
  needles: readonly string[];
  language?: string;
}

const CONFIG_LIBS: ReadonlyArray<ConfigSig> = [
  // TS/JS
  { display: "dotenv", needles: ["dotenv"], language: "TypeScript/JavaScript" },
  { display: "envalid", needles: ["envalid"], language: "TypeScript/JavaScript" },
  { display: "@t3-oss/env-nextjs", needles: ["@t3-oss/env-nextjs", "@t3-oss/env-core"], language: "TypeScript" },
  { display: "znv", needles: ["znv"], language: "TypeScript" },
  { display: "convict", needles: ["convict"], language: "Node.js" },
  { display: "node-config", needles: ["config"], language: "Node.js" },
  // Python
  { display: "pydantic-settings", needles: ["pydantic_settings"], language: "Python" },
  { display: "python-decouple", needles: ["decouple"], language: "Python" },
  { display: "dynaconf", needles: ["dynaconf"], language: "Python" },
  // Go
  { display: "viper", needles: ["github.com/spf13/viper"], language: "Go" },
  { display: "envconfig", needles: ["github.com/kelseyhightower/envconfig"], language: "Go" },
  { display: "godotenv", needles: ["github.com/joho/godotenv"], language: "Go" },
  // Rust
  { display: "config", needles: ["config"], language: "Rust" },
  { display: "envy", needles: ["envy"], language: "Rust" },
  { display: "figment", needles: ["figment"], language: "Rust" },
];

/**
 * Detect a project-local config convention. We look for relative imports
 * whose path component contains "config" (e.g. `./config`, `../config`,
 * `app/config`) and treat them as a project-local convention.
 */
const PROJECT_LOCAL_CONFIG_RE = /(^|[./])config(\.[a-z]+)?$/i;

export function detectConfigEnvPatterns(input: SeedSkillInput): SeedSkillRecord | null {
  const importEdges = collectImportEdges(input.parseResults);
  if (importEdges.length === 0) return null;

  const scores = new Map<string, Set<string>>();
  // First pass: known libraries.
  for (const sig of CONFIG_LIBS) scores.set(sig.display, new Set());
  scores.set("project-local config module", new Set());

  for (const e of importEdges) {
    let matched = false;
    for (const sig of CONFIG_LIBS) {
      if (matchesNeedle(e.module, sig.needles)) {
        scores.get(sig.display)!.add(e.from);
        matched = true;
        break;
      }
    }
    if (matched) continue;
    // Project-local config module — relative imports whose path ends in
    // `config` (with or without an extension).
    if (
      (e.module.startsWith("./") || e.module.startsWith("../") || e.module.includes("/")) &&
      PROJECT_LOCAL_CONFIG_RE.test(e.module)
    ) {
      scores.get("project-local config module")!.add(e.from);
    }
  }

  let bestKey: string | null = null;
  let bestCount = 0;
  for (const [key, importers] of scores) {
    if (importers.size > bestCount) {
      bestCount = importers.size;
      bestKey = key;
    }
  }

  if (!bestKey || bestCount < 2) return null;

  const importers = scores.get(bestKey)!;
  const sortedImporters = Array.from(importers).sort();
  const samplePaths = sortedImporters.slice(0, 5);

  const id = stableId(`seed:config-env:${bestKey}:${sortedImporters.join("|")}`);
  const description = `Codebase reads configuration via \`${bestKey}\` across ${importers.size} file(s).`;
  const body = renderBody({ display: bestKey, importerCount: importers.size, samplePaths });

  return {
    id,
    slug: "config-env",
    name: "Configuration / environment convention",
    description,
    body,
    evidence_count: importers.size,
    sample_paths: samplePaths,
  };
}

interface ImportSite {
  from: string;
  module: string;
}

function collectImportEdges(parseResults: readonly ParseResult[]): ImportSite[] {
  const out: ImportSite[] = [];
  for (const pr of parseResults) {
    for (const e of pr.edges) {
      if (e.kind !== "imports") continue;
      const m = (e.to_path ?? e.to_name ?? "").trim();
      if (m.length === 0) continue;
      out.push({ from: e.from, module: stripQuotes(m) });
    }
  }
  return out;
}

function matchesNeedle(module: string, needles: readonly string[]): boolean {
  for (const n of needles) {
    if (module === n) return true;
    if (module.startsWith(`${n}/`)) return true;
    if (module.startsWith(`${n}.`)) return true;
  }
  return false;
}

interface BodyCtx {
  display: string;
  importerCount: number;
  samplePaths: readonly string[];
}

function renderBody(ctx: BodyCtx): string {
  const lines: string[] = [];
  lines.push("# Configuration / environment convention", "");

  lines.push("## What", "");
  lines.push(
    `This codebase reads configuration via \`${ctx.display}\` across ${ctx.importerCount} file(s). New code that needs configuration values should reuse this entry point rather than reading process / environment variables directly.`,
    "",
  );

  lines.push("## Where", "");
  for (const p of ctx.samplePaths) lines.push(`- \`${p}\``);
  lines.push("");

  lines.push("## How to follow it", "");
  lines.push(
    `When adding a new configuration value, extend the existing schema or central config module rather than reading raw environment variables ad-hoc. Consistency keeps secret handling, defaults, and type-checking in one place.`,
    "",
  );

  return lines.join("\n");
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) {
    return s.slice(1, -1);
  }
  return s;
}

function stableId(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex").slice(0, 32);
}

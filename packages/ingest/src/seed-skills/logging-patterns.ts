// SPDX-License-Identifier: Apache-2.0
// Lodestone — logging-convention seed-skill scanner.
//
// Codex v0.1.1 §11 RED #1: backlog scanner for "Dominant logger import".
// Counts logger-shaped imports across ParseResult edges, picks the highest-
// import-site framework, and emits a single seed Skill describing the
// codebase's logging convention. Conservative gate: ≥2 distinct importing
// files per the §11 spec (one site is not a "convention").

import { createHash } from "node:crypto";

import type { ParseResult } from "../parsers/base.js";

import type { SeedSkillInput, SeedSkillRecord } from "./types.js";

interface LoggerSig {
  display: string;
  /** Module specifiers (or substrings) that indicate this logger is in use. */
  needles: readonly string[];
  /** Optional language hint surfaced in the body. */
  language?: string;
}

const LOGGERS: ReadonlyArray<LoggerSig> = [
  // TS/JS
  { display: "winston", needles: ["winston"], language: "TypeScript/JavaScript" },
  { display: "pino", needles: ["pino"], language: "TypeScript/JavaScript" },
  { display: "bunyan", needles: ["bunyan"], language: "TypeScript/JavaScript" },
  { display: "log4js", needles: ["log4js"], language: "TypeScript/JavaScript" },
  { display: "loglevel", needles: ["loglevel"], language: "TypeScript/JavaScript" },
  { display: "consola", needles: ["consola"], language: "TypeScript/JavaScript" },
  // Python
  { display: "logging (stdlib)", needles: ["logging"], language: "Python" },
  { display: "loguru", needles: ["loguru"], language: "Python" },
  { display: "structlog", needles: ["structlog"], language: "Python" },
  // Go
  { display: "log/slog (stdlib)", needles: ["log/slog"], language: "Go" },
  { display: "logrus", needles: ["github.com/sirupsen/logrus"], language: "Go" },
  { display: "zap", needles: ["go.uber.org/zap"], language: "Go" },
  { display: "zerolog", needles: ["github.com/rs/zerolog"], language: "Go" },
  // Rust
  { display: "tracing", needles: ["tracing"], language: "Rust" },
  { display: "log", needles: ["log"], language: "Rust" },
  { display: "slog", needles: ["slog"], language: "Rust" },
];

export function detectLoggingPatterns(input: SeedSkillInput): SeedSkillRecord | null {
  const importEdges = collectImportEdges(input.parseResults);
  if (importEdges.length === 0) return null;

  // Score: distinct importing-file paths per logger.
  const scores = new Map<number, Set<string>>();
  for (let i = 0; i < LOGGERS.length; i++) scores.set(i, new Set());
  for (const e of importEdges) {
    for (let i = 0; i < LOGGERS.length; i++) {
      if (matchesNeedle(e.module, LOGGERS[i]!.needles)) {
        scores.get(i)!.add(e.from);
        break;
      }
    }
  }

  let bestIdx = -1;
  let bestCount = 0;
  for (const [idx, importers] of scores) {
    if (importers.size > bestCount) {
      bestCount = importers.size;
      bestIdx = idx;
    }
  }

  if (bestIdx < 0 || bestCount < 2) return null;

  const sig = LOGGERS[bestIdx]!;
  const importers = scores.get(bestIdx)!;
  const sortedImporters = Array.from(importers).sort();
  const samplePaths = sortedImporters.slice(0, 5);

  const id = stableId(`seed:logging:${sig.display}:${sortedImporters.join("|")}`);
  const description = `Codebase logs via \`${sig.display}\` across ${importers.size} file(s).`;
  const body = renderBody({
    sig,
    importerCount: importers.size,
    samplePaths,
  });

  return {
    id,
    slug: "logging",
    name: "Logging convention",
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
  sig: LoggerSig;
  importerCount: number;
  samplePaths: readonly string[];
}

function renderBody(ctx: BodyCtx): string {
  const lines: string[] = [];
  lines.push("# Logging convention", "");

  lines.push("## What", "");
  const langSuffix = ctx.sig.language ? ` (${ctx.sig.language})` : "";
  lines.push(
    `This codebase logs via \`${ctx.sig.display}\`${langSuffix} across ${ctx.importerCount} file(s). New code should use the same logger; do not introduce a parallel logging library without an explicit team decision.`,
    "",
  );

  lines.push("## Where", "");
  for (const p of ctx.samplePaths) lines.push(`- \`${p}\``);
  lines.push("");

  lines.push("## How to follow it", "");
  lines.push(
    `When adding logging to a new module, import \`${ctx.sig.display}\` (matching the existing import shape from the sample sites above) and use the project's existing logger configuration. PR reviewers should reject net-new logging that bypasses this convention.`,
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

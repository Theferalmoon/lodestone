// SPDX-License-Identifier: Apache-2.0
// Lodestone — test-convention seed-skill scanner.
//
// Codex v0.1.1 §11 RED #1: backlog scanner from the original §11 spec
// "Test convention" pattern. Detects test files by path glob and tries to
// identify the dominant test framework from import edges. Conservative:
// requires ≥2 test files; defaults to a generic "project test runner" label
// when no framework signal is found (per spec — never guess).

import { createHash } from "node:crypto";

import type { LodestoneSymbol } from "@lodestone/shared";

import type { ParseResult, ParserEdge } from "../parsers/base.js";

import type { SeedSkillInput, SeedSkillRecord } from "./types.js";

/** Path-based test-file matchers. */
const TEST_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /\.test\.[a-z]+$/,
  /\.spec\.[a-z]+$/,
  /(^|\/)test_[^/]+\.py$/,
  /[^/]+_test\.go$/,
  /(^|\/)tests?\/.+\.(ts|tsx|js|jsx|mjs|py|rs|go)$/,
];

/**
 * Curated test-framework signatures keyed by import-source needles. The
 * resolved framework label is what the SKILL.md card surfaces.
 */
interface FrameworkSig {
  display: string;
  needles: readonly string[];
}

const FRAMEWORKS: ReadonlyArray<FrameworkSig> = [
  { display: "Vitest", needles: ["vitest"] },
  { display: "Jest", needles: ["jest", "@jest/globals"] },
  { display: "Mocha", needles: ["mocha"] },
  { display: "Jasmine", needles: ["jasmine"] },
  { display: "Playwright", needles: ["@playwright/test", "playwright"] },
  { display: "Cypress", needles: ["cypress"] },
  { display: "pytest", needles: ["pytest"] },
  { display: "unittest", needles: ["unittest"] },
];

interface TestFile {
  path: string;
  language?: LodestoneSymbol["language"];
}

export function detectTestPatterns(input: SeedSkillInput): SeedSkillRecord | null {
  const seenPaths = new Set<string>();
  const testFiles: TestFile[] = [];
  // Collect every distinct path that looks like a test file. Symbols give
  // us all parsed paths; imports edges may include the same path again.
  for (const pr of input.parseResults) {
    for (const sym of pr.symbols) {
      if (!sym.path || seenPaths.has(sym.path)) continue;
      if (matchesTestPath(sym.path)) {
        seenPaths.add(sym.path);
        testFiles.push({ path: sym.path, language: sym.language });
      }
    }
    for (const edge of pr.edges) {
      if (edge.kind !== "imports") continue;
      const path = edge.from;
      if (seenPaths.has(path)) continue;
      if (matchesTestPath(path)) {
        seenPaths.add(path);
        testFiles.push({ path });
      }
    }
  }

  if (testFiles.length < 2) return null;

  const framework = identifyFramework(input.parseResults, testFiles);

  // Stable, content-derived id.
  const sortedPaths = testFiles.map((t) => t.path).sort();
  const id = stableId(`seed:tests:${framework ?? "unknown"}:${sortedPaths.join("|")}`);

  const samplePaths = sortedPaths.slice(0, 5);
  const description = `Codebase keeps ${testFiles.length} test file(s)${
    framework ? ` using ${framework}` : ""
  }; conventional naming + colocation.`;
  const body = renderBody({ framework, testFiles, samplePaths });

  return {
    id,
    slug: "tests",
    name: "Test convention",
    description,
    body,
    evidence_count: testFiles.length,
    sample_paths: samplePaths,
  };
}

function matchesTestPath(path: string): boolean {
  for (const re of TEST_PATH_PATTERNS) {
    if (re.test(path)) return true;
  }
  return false;
}

/**
 * Pick the dominant framework. Strategy:
 *   1. Score each framework by the number of test-file imports that match
 *      one of its needles (counting distinct importing paths, not edges).
 *   2. If any framework wins, return its display label.
 *   3. If no imports were seen but every test path is `*_test.go`, label
 *      the result "Go test" (the canonical Go convention is testing.T,
 *      not an importable framework).
 *   4. Otherwise return null — body will fall back to the generic label.
 */
function identifyFramework(
  parseResults: readonly ParseResult[],
  testFiles: readonly TestFile[],
): string | null {
  const testPathSet = new Set(testFiles.map((t) => t.path));
  const importEdges = collectImportEdges(parseResults).filter((e) =>
    testPathSet.has(e.from),
  );

  const scores = new Map<string, Set<string>>();
  for (const sig of FRAMEWORKS) {
    scores.set(sig.display, new Set());
  }
  for (const edge of importEdges) {
    for (const sig of FRAMEWORKS) {
      if (matchesAnyNeedle(edge.module, sig.needles)) {
        scores.get(sig.display)!.add(edge.from);
        break;
      }
    }
  }

  let best: { display: string; count: number } | null = null;
  for (const [display, importers] of scores) {
    if (importers.size === 0) continue;
    if (!best || importers.size > best.count) {
      best = { display, count: importers.size };
    }
  }
  if (best) return best.display;

  // Fallback: Go _test.go convention with no importable framework.
  const allGoTest = testFiles.every((t) => /(^|\/)[^/]+_test\.go$/.test(t.path));
  if (allGoTest && testFiles.length > 0) return "Go test";
  return null;
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

function matchesAnyNeedle(module: string, needles: readonly string[]): boolean {
  for (const n of needles) {
    if (module === n) return true;
    if (module.startsWith(`${n}/`)) return true;
    if (module.startsWith(`${n}.`)) return true;
  }
  return false;
}

interface BodyCtx {
  framework: string | null;
  testFiles: readonly TestFile[];
  samplePaths: readonly string[];
}

function renderBody(ctx: BodyCtx): string {
  const lines: string[] = [];
  lines.push("# Test convention", "");

  lines.push("## What", "");
  if (ctx.framework) {
    lines.push(
      `This codebase keeps ${ctx.testFiles.length} test file(s) and uses **${ctx.framework}** as the project test runner. Conventional file naming (\`*.test.*\` / \`*.spec.*\` / \`*_test.go\` / \`test_*.py\`) plus colocation with the code under test.`,
      "",
    );
  } else {
    lines.push(
      `This codebase keeps ${ctx.testFiles.length} test file(s) named with the conventional suffixes (\`*.test.*\` / \`*.spec.*\` / \`*_test.go\` / \`test_*.py\`). The exact test framework could not be identified from imports — use the project's existing test runner.`,
      "",
    );
  }

  lines.push("## Where", "");
  if (ctx.samplePaths.length === 0) {
    lines.push("- _no representative paths_");
  } else {
    for (const p of ctx.samplePaths) lines.push(`- \`${p}\``);
  }
  lines.push("");

  lines.push("## How to follow it", "");
  lines.push(
    `When adding a new test, place it next to the source file it covers and use the same suffix convention (e.g. \`foo.ts\` -> \`foo.test.ts\`). Reuse the existing ${
      ctx.framework ?? "test runner"
    } configuration; do NOT add a competing test framework alongside it.`,
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

// Re-export ParseResult so consumers don't have to dig into parsers/base.
export type { ParseResult, ParserEdge };

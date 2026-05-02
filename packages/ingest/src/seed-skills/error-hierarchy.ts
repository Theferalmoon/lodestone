// SPDX-License-Identifier: Apache-2.0
// Lodestone — error-hierarchy seed-skill scanner.
//
// Consumes §06 ClassInheritance triples (one per class extends/implements
// edge) and identifies the dominant custom-error family in the codebase.
// Per §11 spec + POST-CODEX-001 amendment §3, the scanner operates on the
// already-extracted triples — no re-parsing.
//
// Heuristic: a "custom error" is any class whose `base_name` matches one of
// the well-known root names below (case-sensitive on the rightmost segment so
// `foo.Error` and `MyLib.Error` both count). The largest connected family
// (root + descendants) becomes the seed Skill. Sample size <2 → no card per
// §11 "scanners do not emit a card for patterns with sample size < 2".

import { createHash } from "node:crypto";

import type { LodestoneSymbol } from "@lodestone/shared";

import type { ParseResult } from "../parsers/base.js";

import type { SeedSkillInput, SeedSkillRecord } from "./types.js";

/** Known error/exception root class names across supported languages. */
const ERROR_ROOTS: ReadonlySet<string> = new Set([
  // TypeScript / JavaScript
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  // Python
  "Exception",
  "BaseException",
  "RuntimeError",
  "ValueError",
  // Go (idiomatic — types implementing Error() string. We use the interface
  // name when authors name their base error type "error" or "Err*"; the
  // parser may also surface explicit base class extensions.)
  "error",
  // Rust
  "Error", // std::error::Error trait — already covered; kept for clarity
]);

interface ErrorClass {
  /** Canonical class id (matches LodestoneSymbol.symbol). */
  class_id: string;
  /** Base name as written in source. */
  base_name: string;
  /** Resolved last segment of base_name (e.g. `MyLib.Error` -> `Error`). */
  base_root: string;
  /** Path the class lives in (resolved via the symbols index). */
  path?: string;
  /** Display-friendly class name (last segment of class_id). */
  display_name: string;
}

/**
 * Identify the dominant custom-error family across the parsed corpus.
 *
 * Returns `null` when:
 * - no class_inheritance triples reference a known error root, OR
 * - the largest detected family has fewer than 2 members (single custom
 *   Error class is not a "convention").
 */
export function detectErrorHierarchy(input: SeedSkillInput): SeedSkillRecord | null {
  const symbolIndex = buildSymbolIndex(input.parseResults);
  const errorClasses: ErrorClass[] = [];

  for (const result of input.parseResults) {
    for (const triple of result.class_inheritance) {
      const root = lastSegment(triple.base_name);
      if (!ERROR_ROOTS.has(root)) continue;
      const sym = symbolIndex.get(triple.class_id);
      const display = lastClassSegment(triple.class_id);
      errorClasses.push({
        class_id: triple.class_id,
        base_name: triple.base_name,
        base_root: root,
        path: sym?.path,
        display_name: display,
      });
    }
  }

  if (errorClasses.length < 2) return null;

  // Group by base_root; pick the largest family.
  const byRoot = new Map<string, ErrorClass[]>();
  for (const ec of errorClasses) {
    const bucket = byRoot.get(ec.base_root) ?? [];
    bucket.push(ec);
    byRoot.set(ec.base_root, bucket);
  }

  let dominant: { root: string; members: ErrorClass[] } | null = null;
  for (const [root, members] of byRoot) {
    if (!dominant || members.length > dominant.members.length) {
      dominant = { root, members };
    }
  }
  if (!dominant || dominant.members.length < 2) return null;

  return buildErrorSkill(dominant.root, dominant.members);
}

function buildErrorSkill(root: string, members: ErrorClass[]): SeedSkillRecord {
  // Stable deterministic-seed id (UUIDv5-ish — a content-derived hash so the
  // same codebase always produces the same Skill id).
  const idSource = `seed:errors:${root}:${members
    .map((m) => m.class_id)
    .sort()
    .join("|")}`;
  const id = stableId(idSource);

  const samplePaths = uniquePaths(members).slice(0, 5);
  const sampleClassNames = members.slice(0, 5).map((m) => m.display_name);

  const description = `Codebase models errors as a hierarchy of ${members.length} class(es) descending from \`${root}\`.`;

  const body = renderErrorBody({
    root,
    members,
    samplePaths,
    sampleClassNames,
  });

  return {
    id,
    slug: "errors",
    name: "Error / exception convention",
    description,
    body,
    evidence_count: members.length,
    sample_paths: samplePaths,
  };
}

interface BodyContext {
  root: string;
  members: ErrorClass[];
  samplePaths: string[];
  sampleClassNames: string[];
}

function renderErrorBody(ctx: BodyContext): string {
  const lines: string[] = [];
  lines.push("# Error / exception convention", "");

  lines.push("## What", "");
  lines.push(
    `This codebase defines ${ctx.members.length} custom error class(es) that descend from \`${ctx.root}\`. New error types should follow the same pattern: subclass \`${ctx.root}\` (or one of the existing descendants) so callers can catch the family with a single \`instanceof\` check.`,
    "",
  );

  lines.push("## Where", "");
  if (ctx.samplePaths.length === 0) {
    lines.push("- _no member paths recorded_");
  } else {
    for (const p of ctx.samplePaths) lines.push(`- \`${p}\``);
  }
  lines.push("");

  if (ctx.sampleClassNames.length > 0) {
    lines.push("## Sample classes", "");
    for (const c of ctx.sampleClassNames) lines.push(`- \`${c}\``);
    lines.push("");
  }

  lines.push("## How to follow it", "");
  lines.push(
    `When adding a new failure mode, define a subclass of \`${ctx.root}\` (or an existing descendant) with a descriptive name ending in \`Error\` or \`Exception\`. Throw that subclass instead of a bare \`${ctx.root}\` so callers can catch the specific case while still falling back to the family root.`,
    "",
  );

  return lines.join("\n");
}

function buildSymbolIndex(
  parseResults: readonly ParseResult[],
): Map<string, LodestoneSymbol> {
  const idx = new Map<string, LodestoneSymbol>();
  for (const result of parseResults) {
    for (const sym of result.symbols) {
      // The §06 parsers use the qualified name as the symbol id at this layer.
      idx.set(sym.symbol, sym);
    }
  }
  return idx;
}

/** Last `::` segment of a canonical class id (e.g. "src/foo.ts::A::B" → "B"). */
function lastClassSegment(classId: string): string {
  const parts = classId.split("::");
  return parts[parts.length - 1] ?? classId;
}

/** Last `.`-segment of a base name (handles `MyLib.Error` → `Error`). */
function lastSegment(baseName: string): string {
  const trimmed = baseName.replace(/<.*$/, "").trim();
  const parts = trimmed.split(".");
  return parts[parts.length - 1] ?? trimmed;
}

function uniquePaths(members: readonly ErrorClass[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of members) {
    if (!m.path) continue;
    if (seen.has(m.path)) continue;
    seen.add(m.path);
    out.push(m.path);
  }
  return out;
}

function stableId(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex").slice(0, 32);
}

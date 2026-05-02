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
 * Codex v0.1.1 §11 RED #2: traversal must climb the inheritance graph rather
 * than only counting one-hop descendants of built-in roots. The common shape
 * `AppError extends Error; NotFoundError extends AppError; …` would otherwise
 * produce a family of size 1 and emit no card. We now seed the graph with
 * built-in roots and BFS over child relationships to gather the full
 * transitive descendant set.
 *
 * Codex v0.1.1 §11 RED #3: the Rust parser represents `impl Trait for Type`
 * as a synthetic class id `impl_<Trait>_for_<Type>`. We detect that shape and
 * use the implementing struct (`Type`) as the displayed class name so the
 * card surfaces real type names, not parser-internal synthetic ids.
 *
 * Returns `null` when:
 * - no class_inheritance triples reference a known error root, OR
 * - the largest detected family has fewer than 2 members (single custom
 *   Error class is not a "convention").
 */
export function detectErrorHierarchy(input: SeedSkillInput): SeedSkillRecord | null {
  const symbolIndex = buildSymbolIndex(input.parseResults);

  // 1. Collect every (child_class_id, base_name_root) edge across all parses.
  //    `base_name_root` is the resolved root used for built-in-root matching;
  //    we keep it alongside the raw base for graph-walk identity below.
  interface Edge {
    class_id: string;
    base_name: string;
    base_root: string;
    path?: string;
    display_name: string;
  }
  const edges: Edge[] = [];
  for (const result of input.parseResults) {
    for (const triple of result.class_inheritance) {
      const root = lastSegment(triple.base_name);
      const sym = symbolIndex.get(triple.class_id);
      edges.push({
        class_id: triple.class_id,
        base_name: triple.base_name,
        base_root: root,
        path: sym?.path,
        display_name: friendlyClassName(triple.class_id),
      });
    }
  }
  if (edges.length === 0) return null;

  // 2. Index parents by every name a child might use to reference them.
  //    A child like `class B extends A` writes base_name="A". A child like
  //    `class B extends errors.AppError` writes base_name="errors.AppError"
  //    while the parent class id ends in "AppError". Without indexing both
  //    forms the BFS misses transitive chains where the qualifier flips
  //    between hops (Codex r2 §11 PARTIAL: `NotFoundError extends
  //    errors.AppError` after `AppError extends Error`).
  const childrenByParentName = new Map<string, Edge[]>();
  const addParentKey = (key: string, edge: Edge) => {
    const trimmed = key.trim();
    if (!trimmed) return;
    const bucket = childrenByParentName.get(trimmed) ?? [];
    if (!bucket.some((b) => b.class_id === edge.class_id)) {
      bucket.push(edge);
    }
    childrenByParentName.set(trimmed, bucket);
  };
  for (const e of edges) {
    // (a) Raw base_name as written ("errors.AppError").
    addParentKey(e.base_name, e);
    // (b) Last-segment / bare form ("AppError"). Lets a child written as
    //     "errors.AppError" match a parent whose display_name is "AppError".
    if (e.base_root && e.base_root !== e.base_name.trim()) {
      addParentKey(e.base_root, e);
    }
  }

  // 3. For each built-in error root, BFS over children and grandchildren etc.
  //    A child is identified by an edge whose `base_root` matches the seed
  //    root OR whose `base_name` matches the display name of any already-
  //    discovered descendant. Codex r2 §11 PARTIAL: enqueue both the bare
  //    display name AND any qualified forms a downstream child might use,
  //    so chains that flip between qualifier styles are not lost.
  let dominant: { root: string; members: Edge[] } | null = null;
  for (const root of ERROR_ROOTS) {
    const collected = new Map<string, Edge>();
    const queue: string[] = [root];
    const enqueued = new Set<string>([root]);
    const enqueue = (name: string) => {
      const trimmed = name.trim();
      if (!trimmed || enqueued.has(trimmed)) return;
      enqueued.add(trimmed);
      queue.push(trimmed);
    };
    // Direct descendants — base_root matches the seed root.
    for (const e of edges) {
      if (e.base_root === root && !collected.has(e.class_id)) {
        collected.set(e.class_id, e);
        enqueue(e.display_name);
        // A descendant referenced as "ns.Display" elsewhere should match.
        enqueue(`${root}.${e.display_name}`);
      }
    }
    // Transitive descendants — climb by display-name match.
    while (queue.length > 0) {
      const parentName = queue.shift()!;
      const kids = childrenByParentName.get(parentName) ?? [];
      for (const kid of kids) {
        if (collected.has(kid.class_id)) continue;
        collected.set(kid.class_id, kid);
        enqueue(kid.display_name);
        // Re-enqueue the parent's qualified prefix combined with the kid's
        // display name (e.g. "errors.NotFoundError") so a grand-kid using
        // "errors.NotFoundError extends ..." pattern still resolves.
        const parentPrefix = parentName.includes(".")
          ? parentName.slice(0, parentName.lastIndexOf("."))
          : null;
        if (parentPrefix) enqueue(`${parentPrefix}.${kid.display_name}`);
      }
    }
    if (collected.size < 2) continue;
    const members = Array.from(collected.values());
    if (!dominant || members.length > dominant.members.length) {
      dominant = { root, members };
    }
  }
  if (!dominant || dominant.members.length < 2) return null;

  return buildErrorSkill(
    dominant.root,
    dominant.members.map((e) => ({
      class_id: e.class_id,
      base_name: e.base_name,
      base_root: e.base_root,
      path: e.path,
      display_name: e.display_name,
    })),
  );
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

/**
 * Codex v0.1.1 §11 RED #3 + r2 PARTIAL: map a parser-internal class id to
 * a friendly display name. Rust's parser emits `impl Trait for Type` as a
 * synthetic symbol whose name starts with `impl_<Trait>_for_<Type>`. When
 * the trait is fully scoped (`impl std::error::Error for MyErr`), the
 * literal symbol name is `impl_std::error::Error_for_MyErr`, which gets
 * `qualifiedName`-joined as `path::impl_std::error::Error_for_MyErr`.
 *
 * The pre-r2 implementation only inspected the last `::` segment, so it
 * saw `Error_for_MyErr` and missed the `impl_` prefix entirely — returning
 * `Error_for_MyErr` (the wrong friendly name) instead of `MyErr`.
 *
 * r2 fix: walk segments from the right looking for an `impl_` start, then
 * recombine the trailing segments into the synthetic body and parse with
 * the rightmost `_for_` to recover the implementing type. For all other
 * languages the last `::` segment IS the class name, so this falls through
 * to lastClassSegment.
 */
function friendlyClassName(classId: string): string {
  const segments = classId.split("::");
  for (let i = 0; i < segments.length; i++) {
    if (segments[i]!.startsWith("impl_")) {
      // Recombine segments[i..] back into the full synthetic body. The
      // first segment carries the `impl_` prefix; later segments lost
      // their `::` separators when the parser built the literal id, so we
      // rejoin them here. Rightmost `_for_` then splits trait from type.
      const body = segments.slice(i).join("::").slice("impl_".length);
      const cut = body.lastIndexOf("_for_");
      if (cut >= 0) {
        const target = body.slice(cut + "_for_".length);
        // Strip trailing `::` segments off the recovered target — if the
        // synthetic was `impl_..._for_some::Type`, the implementer is
        // `Type`. Defensive against future parser changes.
        const t = target.split("::");
        return t[t.length - 1] ?? target;
      }
    }
  }
  return lastClassSegment(classId);
}

/**
 * Last name segment of a base name. Handles `MyLib.Error` → `Error` (TS/JS
 * dotted style) AND `std::error::Error` → `Error` (Rust scoped style).
 *
 * Codex r2 §11 PARTIAL: Rust trait names like `std::error::Error` were
 * passed through as a single token because the prior split was `.`-only,
 * so they never matched the bare `"Error"` member of ERROR_ROOTS.
 */
function lastSegment(baseName: string): string {
  const trimmed = baseName.replace(/<.*$/, "").trim();
  // First peel off Rust scope (`::`); then peel off any dotted namespace
  // qualifier that remains.
  const lastScope = trimmed.split("::").pop() ?? trimmed;
  const parts = lastScope.split(".");
  return parts[parts.length - 1] ?? lastScope;
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

// SPDX-License-Identifier: Apache-2.0
// Lodestone — fixture builders for the §11 seed-skills tests.

import type { LodestoneSymbol } from "@lodestone/shared";

import type { ClassInheritance, ParseResult, ParserEdge } from "../../parsers/base.js";

export interface ClassDef {
  /** Canonical id — e.g. "src/errors.ts::AppError". */
  id: string;
  /** Source path. */
  path: string;
  /** Base class name as written in source (may be qualified). */
  base: string;
  language?: LodestoneSymbol["language"];
}

/**
 * Build a ParseResult from a list of class-extends records. The symbol entry
 * for each class is created automatically so the error-hierarchy scanner can
 * resolve `class_id` → path via the symbol index.
 */
export function mkClassParseResult(classes: readonly ClassDef[]): ParseResult {
  const symbols: LodestoneSymbol[] = classes.map((c) => ({
    symbol: c.id,
    path: c.path,
    range: { start_line: 1, end_line: 5 },
    language: c.language ?? "typescript",
    kind: "class",
  }));
  const inheritance: ClassInheritance[] = classes.map((c) => ({
    class_id: c.id,
    base_name: c.base,
  }));
  return {
    symbols,
    edges: [],
    class_inheritance: inheritance,
    warnings: [],
  };
}

/**
 * Build a ParseResult representing a single file's `imports` edges. Used by
 * the framework-detector tests.
 *
 * `importerPath` becomes the `from` field on every edge (parsers set the
 * importer path as `from` for `imports` edges).
 */
export function mkImportsParseResult(
  importerPath: string,
  modules: readonly string[],
): ParseResult {
  const edges: ParserEdge[] = modules.map((m) => ({
    from: importerPath,
    to_name: m,
    to_path: m,
    kind: "imports",
  }));
  return {
    symbols: [],
    edges,
    class_inheritance: [],
    warnings: [],
  };
}

/**
 * Tiny synthetic "demo repo" snapshot: a handful of error classes plus a
 * couple of files importing express. Exercises both scanners in one shot.
 */
export function demoCorpus(): ParseResult[] {
  return [
    mkClassParseResult([
      { id: "src/errors.ts::AppError", path: "src/errors.ts", base: "Error" },
      { id: "src/errors.ts::ValidationError", path: "src/errors.ts", base: "AppError" },
      { id: "src/errors.ts::AuthError", path: "src/errors.ts", base: "Error" },
      { id: "src/errors.ts::NotFoundError", path: "src/errors.ts", base: "Error" },
    ]),
    mkImportsParseResult("src/server.ts", ["express", "./errors"]),
    mkImportsParseResult("src/router.ts", ["express", "./errors"]),
    mkImportsParseResult("src/middleware.ts", ["express"]),
  ];
}

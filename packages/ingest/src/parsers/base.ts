// SPDX-License-Identifier: Apache-2.0
// AbstractParser interface + ParseResult type. Each per-language parser
// implements this contract: take a source buffer/string, return symbols +
// edges + warnings without ever throwing on broken input.
//
// Per the §06 spec, the shape of `Symbol` and `Edge` is owned by
// `@lodestone/shared`; this module only adds the parser-level glue
// (ParseResult, ClassInheritance, helpers).

import { createHash } from "node:crypto";
import type { EdgeKind, Language, SymbolKind, Symbol as LodestoneSymbolType } from "@lodestone/shared";

/**
 * Class-inheritance triple emitted by parsers (POST-CODEX-001 amendment §1).
 *
 * - `class_id` — the canonical id of the deriving class symbol (matches `LodestoneSymbol.symbol`).
 * - `base_name` — the bare or qualified name of the base class / trait, as written in source.
 * - `base_path` — best-effort hint when the base lives in an importable module
 *   (e.g. resolved import target). Resolution to a real symbol id is §11's job.
 */
export interface ClassInheritance {
  class_id: string;
  base_name: string;
  base_path?: string;
}

/**
 * Parser-level edge shape. Distinct from the SQLite `EdgeRow` (which has
 * `from_id` / `to_id` resolved ids) because §06 has no cross-file symbol
 * table yet — that lives in §07 / §08.
 *
 * - `from` is always a resolved canonical id (the symbol id of the caller / importer).
 * - `to_name` is the bare or qualified target name as written in source.
 * - `to_path` is an optional resolution hint (e.g. import source string `"./y"`).
 */
export interface ParserEdge {
  from: string;
  to_name: string;
  to_path?: string;
  kind: EdgeKind;
}

export interface ParseResult {
  symbols: LodestoneSymbolType[];
  edges: ParserEdge[];
  /** Class-inheritance triples — POST-CODEX-001 amendment §1. */
  class_inheritance: ClassInheritance[];
  /** Populated when partial-parse occurs (broken file recovery). */
  warnings: string[];
}

export interface AbstractParser {
  readonly language: Language;
  /**
   * Parse a source buffer and return symbols + edges + class-inheritance
   * triples. MUST NOT throw on syntactically broken input — return whatever
   * could be extracted, with a human-readable warning.
   *
   * Strips a leading UTF-8 BOM if present so positions match LSP convention
   * (BOM does not shift line numbers).
   */
  parse(path: string, source: Buffer | string): Promise<ParseResult>;
}

/** Strip a leading UTF-8 BOM if present. */
export function stripBom(text: string): string {
  return text.length > 0 && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Coerce Buffer | string to UTF-8 string. */
export function toString(source: Buffer | string): string {
  return typeof source === "string" ? source : source.toString("utf8");
}

/**
 * Deterministic 16-hex-char SHA1 of `${path}|${qualifiedName}|${startLine}`.
 * Used as the symbol's stable id (matches `SymbolRow.id` shape).
 */
export function symbolId(filePath: string, qualifiedName: string, startLine: number): string {
  return createHash("sha1")
    .update(`${filePath}|${qualifiedName}|${startLine}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Build the canonical qualified name. Top-level: `<path>::<name>`.
 * Method/nested: `<path>::<Parent>::<...>::<name>`.
 */
export function qualifiedName(filePath: string, parents: string[], name: string): string {
  return [filePath, ...parents, name].join("::");
}

/** Map tree-sitter 0-based row to our 1-based start_line / end_line. */
export function toRange(start: { row: number }, end: { row: number }): { start_line: number; end_line: number } {
  return { start_line: start.row + 1, end_line: end.row + 1 };
}

/** Type re-exports kept narrow so callers can import everything from `./base.js`. */
export type { Language, SymbolKind, EdgeKind } from "@lodestone/shared";

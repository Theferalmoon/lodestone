// SPDX-License-Identifier: Apache-2.0
// JavaScript / JSX parser. Extracts function/method/class/import + calls/imports/extends.

import type { Node } from "web-tree-sitter";

import type { Symbol as LodestoneSymbolType } from "@lodestone/shared";
import {
  type AbstractParser,
  type ClassInheritance,
  type ParseResult,
  type ParserEdge,
  addFileAsModuleSymbolIfNeeded,
  qualifiedName,
  stripBom,
  symbolId,
  toRange,
  toString,
} from "./base.js";
import { getParser } from "./wasm-loader.js";

interface Ctx {
  filePath: string;
  parents: string[];
  symbols: LodestoneSymbolType[];
  edges: ParserEdge[];
  class_inheritance: ClassInheritance[];
  warnings: string[];
}

function firstLine(text: string): string {
  const idx = text.indexOf("\n");
  return (idx === -1 ? text : text.slice(0, idx)).trim();
}

function leadingDocstring(node: Node): string | undefined {
  let cursor: Node | null = node.previousSibling;
  const lines: string[] = [];
  while (cursor && cursor.type === "comment") {
    lines.unshift(cursor.text);
    cursor = cursor.previousSibling;
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}

function importSourceOf(node: Node): string | undefined {
  const src = node.childForFieldName("source");
  if (!src) return undefined;
  const frag = src.namedChildren.find((c) => c.type === "string_fragment");
  return frag?.text ?? src.text.replace(/^["'`]|["'`]$/g, "");
}

function pushSymbol(
  ctx: Ctx,
  node: Node,
  name: string,
  kind: LodestoneSymbolType["kind"]
): string {
  const range = toRange(node.startPosition, node.endPosition);
  const qname = qualifiedName(ctx.filePath, ctx.parents, name);
  // POST-§20 fix (Issue A): emit qname as the canonical id so ParserEdge.from
  // matches `LodestoneSymbol.symbol` everywhere downstream (resolveEdges,
  // buildGraph, SQLite). `symbolId` (SHA1) is retained for back-compat.
  const id = qname;
  void symbolId;
  const sig = firstLine(node.text);
  ctx.symbols.push({
    symbol: qname,
    path: ctx.filePath,
    range,
    language: "javascript",
    kind,
    signature: sig.length > 0 ? sig : undefined,
    docstring: leadingDocstring(node),
  });
  return id;
}

/**
 * Node types that carry their own `LodestoneSymbol`. Walking past them in
 * `collectCalls` would double-attribute calls inside the inner symbol to
 * the outer one (RED §06 #1). Inline `arrow_function` / `function_expression`
 * are intentionally NOT in this set — they only become symbols when assigned
 * to a top-level const (handled in `isSymbolEmittingDeclaration`).
 */
const JS_NESTED_SYMBOL_TYPES = new Set<string>([
  "function_declaration",
  "class_declaration",
  "method_definition",
]);

function isSymbolEmittingDeclaration(n: Node): boolean {
  if (n.type !== "lexical_declaration" && n.type !== "variable_declaration") {
    return false;
  }
  for (const decl of n.namedChildren) {
    if (decl.type !== "variable_declarator") continue;
    const value = decl.childForFieldName("value");
    if (!value) continue;
    if (value.type === "arrow_function" || value.type === "function_expression") {
      return true;
    }
  }
  return false;
}

function collectCalls(ctx: Ctx, fromId: string, root: Node): void {
  const stack: Node[] = [];
  for (const c of root.namedChildren) stack.push(c);
  while (stack.length > 0) {
    const n = stack.pop();
    if (!n) continue;
    if (JS_NESTED_SYMBOL_TYPES.has(n.type) || isSymbolEmittingDeclaration(n)) {
      continue;
    }
    if (n.type === "call_expression") {
      const fn = n.childForFieldName("function");
      if (fn) {
        let target = fn.text;
        if (fn.type === "member_expression") {
          target = fn.childForFieldName("property")?.text ?? fn.text;
        }
        ctx.edges.push({ from: fromId, to_name: target, kind: "calls" });
      }
    }
    for (const c of n.namedChildren) stack.push(c);
  }
}

function walk(ctx: Ctx, node: Node): void {
  switch (node.type) {
    case "import_statement": {
      const source = importSourceOf(node);
      ctx.edges.push({
        from: ctx.filePath,
        to_name: source ?? node.text,
        to_path: source,
        kind: "imports",
      });
      pushSymbol(ctx, node, source ?? node.text, "module");
      return;
    }
    case "function_declaration": {
      const name = node.childForFieldName("name")?.text ?? "<anonymous>";
      const id = pushSymbol(ctx, node, name, "function");
      const body = node.childForFieldName("body");
      if (body) collectCalls(ctx, id, body);
      // Codex r2 §06 PARTIAL: re-enter body so nested declarations are walked
      // as their own symbols (with their own collectCalls). Mirrors TS pattern
      // — the boundary in collectCalls() prevents double-attribution; this
      // re-walk recovers the dropped inner symbols.
      const inner: Ctx = { ...ctx, parents: [...ctx.parents, name] };
      if (body) for (const c of body.namedChildren) walk(inner, c);
      return;
    }
    case "class_declaration": {
      const name = node.childForFieldName("name")?.text ?? "<anonymous>";
      const classId = pushSymbol(ctx, node, name, "class");
      const heritage = node.namedChildren.find((c) => c.type === "class_heritage");
      if (heritage) {
        for (const baseExpr of heritage.namedChildren) {
          const baseName = baseExpr.text;
          ctx.edges.push({ from: classId, to_name: baseName, kind: "extends" });
          ctx.class_inheritance.push({ class_id: classId, base_name: baseName });
        }
      }
      const body = node.childForFieldName("body");
      if (body) {
        for (const member of body.namedChildren) {
          if (member.type !== "method_definition") continue;
          const mName = member.childForFieldName("name")?.text ?? "<anonymous>";
          const range = toRange(member.startPosition, member.endPosition);
          const mQname = qualifiedName(ctx.filePath, [name], mName);
          // POST-§20 fix (Issue A): canonical id is the qname.
          const mId = mQname;
          const sig = firstLine(member.text);
          ctx.symbols.push({
            symbol: mQname,
            path: ctx.filePath,
            range,
            language: "javascript",
            kind: "method",
            signature: sig.length > 0 ? sig : undefined,
            docstring: leadingDocstring(member),
          });
          const mBody = member.childForFieldName("body");
          if (mBody) collectCalls(ctx, mId, mBody);
          // Codex r2 §06 PARTIAL: re-walk the method body so nested function
          // declarations inside the method get their own symbol + call edges.
          const methodInner: Ctx = {
            ...ctx,
            parents: [...ctx.parents, name, mName],
          };
          if (mBody) for (const c of mBody.namedChildren) walk(methodInner, c);
        }
      }
      return;
    }
    case "lexical_declaration":
    case "variable_declaration": {
      // Detect CommonJS `const x = require("…")` and surface as an import edge.
      for (const decl of node.namedChildren) {
        if (decl.type !== "variable_declarator") continue;
        const value = decl.childForFieldName("value");
        if (!value) continue;
        if (value.type === "call_expression") {
          const fn = value.childForFieldName("function");
          if (fn?.text === "require") {
            const args = value.childForFieldName("arguments");
            const stringArg = args?.namedChildren.find((c) => c.type === "string");
            const frag = stringArg?.namedChildren.find((c) => c.type === "string_fragment");
            const source = frag?.text;
            if (source) {
              ctx.edges.push({
                from: ctx.filePath,
                to_name: source,
                to_path: source,
                kind: "imports",
              });
            }
          }
        }
        if (value.type === "arrow_function" || value.type === "function_expression") {
          const name = decl.childForFieldName("name")?.text;
          if (!name) continue;
          const range = toRange(decl.startPosition, decl.endPosition);
          const qname = qualifiedName(ctx.filePath, ctx.parents, name);
          // POST-§20 fix (Issue A): canonical id is the qname.
          const id = qname;
          const sig = firstLine(decl.text);
          ctx.symbols.push({
            symbol: qname,
            path: ctx.filePath,
            range,
            language: "javascript",
            kind: "function",
            signature: sig.length > 0 ? sig : undefined,
            docstring: leadingDocstring(node),
          });
          const body = value.childForFieldName("body");
          if (body) collectCalls(ctx, id, body);
          // Codex r2 §06 PARTIAL: re-walk the arrow/function-expression body
          // so nested declarations inside it surface as their own symbols.
          const inner: Ctx = { ...ctx, parents: [...ctx.parents, name] };
          if (body) for (const c of body.namedChildren) walk(inner, c);
        }
      }
      return;
    }
    default:
      if (node.type === "export_statement") {
        for (const c of node.namedChildren) walk(ctx, c);
      }
      return;
  }
}

export const JavaScriptParser: AbstractParser = {
  language: "javascript",
  async parse(filePath, source): Promise<ParseResult> {
    const ctx: Ctx = {
      filePath,
      parents: [],
      symbols: [],
      edges: [],
      class_inheritance: [],
      warnings: [],
    };
    try {
      const text = stripBom(toString(source));
      const parser = await getParser("javascript");
      const tree = parser.parse(text);
      if (!tree) {
        ctx.warnings.push(`tree-sitter returned null tree for ${filePath}`);
        return ctx;
      }
      if (tree.rootNode.hasError) {
        ctx.warnings.push(`partial parse: ${filePath} contains syntax errors`);
      }
      for (const child of tree.rootNode.namedChildren) {
        try {
          walk(ctx, child);
        } catch (err) {
          ctx.warnings.push(
            `node walk failed for ${child.type} in ${filePath}: ${(err as Error).message}`
          );
        }
      }
    } catch (err) {
      ctx.warnings.push(`parser threw on ${filePath}: ${(err as Error).message}`);
    }
    addFileAsModuleSymbolIfNeeded(ctx.symbols, ctx.edges, filePath, "javascript");
    return ctx;
  },
};

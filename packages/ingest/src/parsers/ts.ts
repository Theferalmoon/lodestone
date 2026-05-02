// SPDX-License-Identifier: Apache-2.0
// TypeScript / TSX parser. Picks the TSX grammar for `.tsx` paths so JSX
// expressions parse correctly; both grammars produce the same Symbol shape.

import type { Node } from "web-tree-sitter";

import type { Symbol as LodestoneSymbolType } from "@lodestone/shared";
import {
  type AbstractParser,
  type ClassInheritance,
  type ParseResult,
  type ParserEdge,
  qualifiedName,
  stripBom,
  symbolId,
  toRange,
  toString,
} from "./base.js";
import { getParser, type SupportedLanguage } from "./wasm-loader.js";

function tsGrammarFor(filePath: string): SupportedLanguage {
  return filePath.toLowerCase().endsWith(".tsx") ? "tsx" : "typescript";
}

function firstLine(text: string): string {
  const idx = text.indexOf("\n");
  return (idx === -1 ? text : text.slice(0, idx)).trim();
}

function leadingDocstring(node: Node): string | undefined {
  let cursor: Node | null = node.previousNamedSibling ?? node.previousSibling;
  // Walk back over comment siblings (jsdoc / // line comments stacked above).
  const lines: string[] = [];
  while (cursor && cursor.type === "comment") {
    lines.unshift(cursor.text);
    cursor = cursor.previousSibling;
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}

function nameOf(node: Node, field: string = "name"): string | undefined {
  const n = node.childForFieldName(field);
  return n?.text;
}

function importSourceOf(node: Node): string | undefined {
  // import_statement → source: string → string_fragment
  const src = node.childForFieldName("source");
  if (!src) return undefined;
  const frag = src.namedChildren.find((c) => c.type === "string_fragment");
  return frag?.text ?? src.text.replace(/^["'`]|["'`]$/g, "");
}

interface WalkContext {
  filePath: string;
  parents: string[];
  parentSymbolId: string | null;
  symbols: LodestoneSymbolType[];
  edges: ParserEdge[];
  class_inheritance: ClassInheritance[];
  warnings: string[];
}

function pushSymbol(
  ctx: WalkContext,
  node: Node,
  name: string,
  kind: LodestoneSymbolType["kind"]
): { id: string; qname: string } {
  const range = toRange(node.startPosition, node.endPosition);
  const qname = qualifiedName(ctx.filePath, ctx.parents, name);
  // POST-§20 fix (Issue A): `id` is intentionally the qname, not the SHA1.
  // `LodestoneSymbol.symbol` is the canonical id everywhere downstream
  // (resolveEdges, buildGraph, SQLite symbols.id, §15 graph tools); emitting
  // qname here keeps ParserEdge.from in lock-step with that canonical id so
  // edges resolve without a sha→qname remap. `symbolId` is retained only for
  // back-compat with any caller that still wants the SHA-derived form.
  const id = qname;
  void symbolId;
  const sig = firstLine(node.text);
  const docstring = leadingDocstring(node);
  ctx.symbols.push({
    symbol: qname,
    path: ctx.filePath,
    range,
    language: "typescript",
    kind,
    signature: sig.length > 0 ? sig : undefined,
    docstring,
  });
  return { id, qname };
}

/**
 * Tree-sitter node types that introduce a NEW lexical scope owning its own
 * `LodestoneSymbol`. Walking past them inside `collectCalls` would
 * double-attribute calls inside the inner symbol to the outer one (RED §06
 * #1). The outer-walk re-enters these via `walk()` and emits its own
 * `collectCalls` call against the inner body with the inner id.
 *
 * NOT in this set:
 *   - `arrow_function` / `function_expression` — only the top-level-const
 *     form is surfaced as a separate symbol; inline callbacks like
 *     `arr.map(x => doThing(x))` MUST keep attributing `doThing` to the
 *     surrounding function. The lexical_declaration check below handles the
 *     surfaced form.
 */
const TS_NESTED_SYMBOL_TYPES = new Set<string>([
  "function_declaration",
  "class_declaration",
  "method_definition",
  "interface_declaration",
  "type_alias_declaration",
  "enum_declaration",
]);

/**
 * `lexical_declaration` / `variable_declaration` only become symbol boundaries
 * when the initializer is an arrow_function or function_expression assigned
 * to a name (matches the surfacing logic in `walk()`'s switch case).
 * Otherwise they are ordinary statements like `const x = useState(0)` whose
 * call expressions belong to the enclosing function.
 */
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

function collectCalls(ctx: WalkContext, fromId: string, root: Node): void {
  const stack: Node[] = [];
  // Seed with root's children so a `function_declaration` body root doesn't
  // trigger the skip on the root itself.
  for (const c of root.namedChildren) stack.push(c);
  while (stack.length > 0) {
    const n = stack.pop();
    if (!n) continue;
    if (TS_NESTED_SYMBOL_TYPES.has(n.type) || isSymbolEmittingDeclaration(n)) {
      // Boundary: nested declaration owns its own calls. Don't descend.
      continue;
    }
    if (n.type === "call_expression") {
      const fn = n.childForFieldName("function");
      if (fn) {
        let target = fn.text;
        // member_expression like a.b.c — record the rightmost name.
        if (fn.type === "member_expression") {
          const prop = fn.childForFieldName("property");
          target = prop?.text ?? fn.text;
        }
        ctx.edges.push({ from: fromId, to_name: target, kind: "calls" });
      }
    }
    for (const c of n.namedChildren) stack.push(c);
  }
}

function walk(ctx: WalkContext, node: Node): void {
  switch (node.type) {
    case "import_statement": {
      const source = importSourceOf(node);
      ctx.edges.push({
        from: ctx.filePath,
        to_name: source ?? node.text,
        to_path: source,
        kind: "imports",
      });
      const imp = pushSymbol(ctx, node, source ?? node.text, "module");
      void imp;
      return;
    }
    case "function_declaration": {
      const name = nameOf(node) ?? "<anonymous>";
      const { id, qname } = pushSymbol(ctx, node, name, "function");
      const body = node.childForFieldName("body");
      if (body) collectCalls(ctx, id, body);
      // Walk children for nested functions.
      const inner: WalkContext = { ...ctx, parents: [...ctx.parents, name], parentSymbolId: id };
      void qname;
      if (body) for (const c of body.namedChildren) walk(inner, c);
      return;
    }
    case "class_declaration": {
      const name = nameOf(node) ?? "<anonymous>";
      const { id: classSymId, qname: classQname } = pushSymbol(ctx, node, name, "class");
      // class_heritage → extends_clause + implements_clause
      const heritage = node.namedChildren.find((c) => c.type === "class_heritage");
      if (heritage) {
        for (const clause of heritage.namedChildren) {
          if (clause.type === "extends_clause") {
            for (const baseExpr of clause.namedChildren) {
              const baseName = baseExpr.text;
              ctx.edges.push({ from: classSymId, to_name: baseName, kind: "extends" });
              ctx.class_inheritance.push({ class_id: classSymId, base_name: baseName });
            }
          } else if (clause.type === "implements_clause") {
            for (const iface of clause.namedChildren) {
              const ifaceName = iface.text;
              ctx.edges.push({ from: classSymId, to_name: ifaceName, kind: "implements" });
              ctx.class_inheritance.push({ class_id: classSymId, base_name: ifaceName });
            }
          }
        }
      }
      const body = node.childForFieldName("body");
      if (body) {
        for (const member of body.namedChildren) {
          if (member.type === "method_definition") {
            const mName = nameOf(member) ?? "<anonymous>";
            const range = toRange(member.startPosition, member.endPosition);
            const mQname = qualifiedName(ctx.filePath, [...ctx.parents, name], mName);
            // POST-§20 fix (Issue A): canonical id is the qname.
            const mId = mQname;
            const sig = firstLine(member.text);
            ctx.symbols.push({
              symbol: mQname,
              path: ctx.filePath,
              range,
              language: "typescript",
              kind: "method",
              signature: sig.length > 0 ? sig : undefined,
              docstring: leadingDocstring(member),
            });
            const mBody = member.childForFieldName("body");
            if (mBody) collectCalls(ctx, mId, mBody);
          }
        }
      }
      void classQname;
      return;
    }
    case "interface_declaration": {
      const name = nameOf(node) ?? "<anonymous>";
      pushSymbol(ctx, node, name, "interface");
      return;
    }
    case "type_alias_declaration": {
      const name = nameOf(node) ?? "<anonymous>";
      pushSymbol(ctx, node, name, "type");
      return;
    }
    case "enum_declaration": {
      // §02 SymbolKind doesn't include "enum"; map to "type" (enums are nominal types).
      const name = nameOf(node) ?? "<anonymous>";
      pushSymbol(ctx, node, name, "type");
      return;
    }
    case "lexical_declaration":
    case "variable_declaration": {
      // Top-level `const x = () => …` gets surfaced as a function-style symbol
      // when the initializer is an arrow / function expression. Skip otherwise.
      for (const decl of node.namedChildren) {
        if (decl.type !== "variable_declarator") continue;
        const value = decl.childForFieldName("value");
        if (!value) continue;
        if (value.type === "arrow_function" || value.type === "function_expression") {
          const nameNode = decl.childForFieldName("name");
          if (!nameNode) continue;
          const name = nameNode.text;
          const range = toRange(decl.startPosition, decl.endPosition);
          const qname = qualifiedName(ctx.filePath, ctx.parents, name);
          // POST-§20 fix (Issue A): canonical id is the qname.
          const id = qname;
          const sig = firstLine(decl.text);
          ctx.symbols.push({
            symbol: qname,
            path: ctx.filePath,
            range,
            language: "typescript",
            kind: "function",
            signature: sig.length > 0 ? sig : undefined,
            docstring: leadingDocstring(node),
          });
          const body = value.childForFieldName("body");
          if (body) collectCalls(ctx, id, body);
        }
      }
      return;
    }
    default:
      // Recurse into module-level wrappers (export_statement, etc.).
      if (node.type === "export_statement") {
        for (const c of node.namedChildren) walk(ctx, c);
      }
      return;
  }
}

export const TypeScriptParser: AbstractParser = {
  language: "typescript",
  async parse(filePath, source): Promise<ParseResult> {
    const ctx: WalkContext = {
      filePath,
      parents: [],
      parentSymbolId: null,
      symbols: [],
      edges: [],
      class_inheritance: [],
      warnings: [],
    };
    let text: string;
    try {
      text = stripBom(toString(source));
      const parser = await getParser(tsGrammarFor(filePath));
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
    return ctx;
  },
};

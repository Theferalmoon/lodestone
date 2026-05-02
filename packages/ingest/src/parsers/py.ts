// SPDX-License-Identifier: Apache-2.0
// Python parser. Extracts def/class/import + calls/imports/extends.
//
// Note: Python's grammar uses `function_definition` for both top-level `def`
// and methods inside a `class_definition`. We tag them as "function" or
// "method" based on the walk context.

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

function precedingDocstring(body: Node | null): string | undefined {
  // Python convention: the first statement in a body, if it's a string
  // expression, is the docstring.
  if (!body) return undefined;
  const first = body.namedChildren[0];
  if (!first || first.type !== "expression_statement") return undefined;
  const inner = first.namedChildren[0];
  if (!inner) return undefined;
  if (inner.type !== "string") return undefined;
  return inner.text;
}

function pushSymbol(
  ctx: Ctx,
  node: Node,
  name: string,
  kind: LodestoneSymbolType["kind"],
  body?: Node | null
): string {
  const range = toRange(node.startPosition, node.endPosition);
  const qname = qualifiedName(ctx.filePath, ctx.parents, name);
  // POST-§20 fix (Issue A): canonical id is the qname so ParserEdge.from
  // matches `LodestoneSymbol.symbol`. `symbolId` retained for back-compat.
  const id = qname;
  void symbolId;
  const sig = firstLine(node.text);
  ctx.symbols.push({
    symbol: qname,
    path: ctx.filePath,
    range,
    language: "python",
    kind,
    signature: sig.length > 0 ? sig : undefined,
    docstring: precedingDocstring(body ?? null),
  });
  return id;
}

/**
 * Python node types that own a `LodestoneSymbol` and are re-entered by the
 * outer `walk()` driver with their own `collectCalls` invocation. Skip them
 * inside `collectCalls` to avoid double-attribution (RED §06 #1).
 *
 * `decorated_definition` wraps a function/class definition; we descend into
 * it normally because the inner def IS in this skip set.
 */
const PY_NESTED_SYMBOL_TYPES = new Set<string>([
  "function_definition",
  "class_definition",
]);

function collectCalls(ctx: Ctx, fromId: string, root: Node): void {
  const stack: Node[] = [];
  for (const c of root.namedChildren) stack.push(c);
  while (stack.length > 0) {
    const n = stack.pop();
    if (!n) continue;
    if (PY_NESTED_SYMBOL_TYPES.has(n.type)) continue;
    if (n.type === "call") {
      const fn = n.childForFieldName("function");
      if (fn) {
        let target = fn.text;
        if (fn.type === "attribute") {
          // foo.bar.baz() — record rightmost attribute
          const attr = fn.childForFieldName("attribute");
          target = attr?.text ?? fn.text;
        }
        ctx.edges.push({ from: fromId, to_name: target, kind: "calls" });
      }
    }
    for (const c of n.namedChildren) stack.push(c);
  }
}

function importNamesFromSimple(node: Node): string[] {
  // import a.b, c as d → child `name` fields are dotted_name | aliased_import
  const out: string[] = [];
  for (let i = 0; i < node.namedChildCount; i += 1) {
    const c = node.namedChild(i);
    if (!c) continue;
    if (c.type === "dotted_name") out.push(c.text);
    else if (c.type === "aliased_import") {
      const dn = c.childForFieldName("name");
      if (dn) out.push(dn.text);
    }
  }
  return out;
}

function walk(ctx: Ctx, node: Node, isMethod: boolean = false): void {
  switch (node.type) {
    case "import_statement": {
      for (const name of importNamesFromSimple(node)) {
        ctx.edges.push({
          from: ctx.filePath,
          to_name: name,
          to_path: name,
          kind: "imports",
        });
      }
      pushSymbol(ctx, node, node.text.replace(/\s+/g, " "), "module");
      return;
    }
    case "import_from_statement": {
      const moduleNode = node.childForFieldName("module_name");
      const moduleName = moduleNode?.text ?? "";
      // Each `name` field is a dotted_name representing an imported symbol.
      for (let i = 0; i < node.namedChildCount; i += 1) {
        const fn = node.fieldNameForNamedChild(i);
        const c = node.namedChild(i);
        if (!c || fn !== "name") continue;
        ctx.edges.push({
          from: ctx.filePath,
          to_name: `${moduleName}.${c.text}`,
          to_path: moduleName,
          kind: "imports",
        });
      }
      pushSymbol(ctx, node, node.text.replace(/\s+/g, " "), "module");
      return;
    }
    case "function_definition": {
      const name = node.childForFieldName("name")?.text ?? "<anonymous>";
      const body = node.childForFieldName("body");
      const id = pushSymbol(ctx, node, name, isMethod ? "method" : "function", body);
      if (body) collectCalls(ctx, id, body);
      // Recurse to surface nested defs inside the function body.
      if (body) {
        const inner: Ctx = { ...ctx, parents: [...ctx.parents, name] };
        for (const c of body.namedChildren) walk(inner, c, false);
      }
      return;
    }
    case "decorated_definition": {
      // Walk into the underlying definition.
      for (const c of node.namedChildren) walk(ctx, c, isMethod);
      return;
    }
    case "class_definition": {
      const name = node.childForFieldName("name")?.text ?? "<anonymous>";
      const body = node.childForFieldName("body");
      const classId = pushSymbol(ctx, node, name, "class", body);
      const supers = node.childForFieldName("superclasses");
      if (supers) {
        for (const baseExpr of supers.namedChildren) {
          if (baseExpr.type === "keyword_argument") continue; // metaclass=…
          const baseName = baseExpr.text;
          ctx.edges.push({ from: classId, to_name: baseName, kind: "extends" });
          ctx.class_inheritance.push({ class_id: classId, base_name: baseName });
        }
      }
      if (body) {
        const inner: Ctx = { ...ctx, parents: [...ctx.parents, name] };
        for (const c of body.namedChildren) walk(inner, c, true);
      }
      return;
    }
    default:
      return;
  }
}

export const PythonParser: AbstractParser = {
  language: "python",
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
      const parser = await getParser("python");
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
          walk(ctx, child, false);
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

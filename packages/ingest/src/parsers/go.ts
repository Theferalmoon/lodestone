// SPDX-License-Identifier: Apache-2.0
// Go parser. Extracts func/method/struct/interface/type/import + calls/imports.
// Go has no class inheritance; this parser never emits ClassInheritance triples.

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

function leadingDocstring(node: Node): string | undefined {
  let cursor: Node | null = node.previousSibling;
  const lines: string[] = [];
  while (cursor && cursor.type === "comment") {
    lines.unshift(cursor.text);
    cursor = cursor.previousSibling;
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}

function pushSymbol(
  ctx: Ctx,
  node: Node,
  name: string,
  kind: LodestoneSymbolType["kind"]
): string {
  const range = toRange(node.startPosition, node.endPosition);
  const qname = qualifiedName(ctx.filePath, ctx.parents, name);
  // POST-§20 fix (Issue A): canonical id is the qname.
  const id = qname;
  void symbolId;
  const sig = firstLine(node.text);
  ctx.symbols.push({
    symbol: qname,
    path: ctx.filePath,
    range,
    language: "go",
    kind,
    signature: sig.length > 0 ? sig : undefined,
    docstring: leadingDocstring(node),
  });
  return id;
}

function collectCalls(ctx: Ctx, fromId: string, root: Node): void {
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const n = stack.pop();
    if (!n) continue;
    if (n.type === "call_expression") {
      const fn = n.childForFieldName("function");
      if (fn) {
        let target = fn.text;
        if (fn.type === "selector_expression") {
          // pkg.Func() — record rightmost field
          target = fn.childForFieldName("field")?.text ?? fn.text;
        }
        ctx.edges.push({ from: fromId, to_name: target, kind: "calls" });
      }
    }
    for (const c of n.namedChildren) stack.push(c);
  }
}

function importPath(spec: Node): string | undefined {
  // import_spec → path: interpreted_string_literal → interpreted_string_literal_content
  const pathNode = spec.childForFieldName("path") ?? spec.namedChildren.find((c) => c.type === "interpreted_string_literal");
  if (!pathNode) return undefined;
  const inner = pathNode.namedChildren.find((c) => c.type === "interpreted_string_literal_content");
  return inner?.text ?? pathNode.text.replace(/^"|"$/g, "");
}

function walk(ctx: Ctx, node: Node): void {
  switch (node.type) {
    case "import_declaration": {
      // Either single `import "x"` or block `import ( "x" "y" )` — both yield import_spec children.
      const stack: Node[] = [node];
      while (stack.length > 0) {
        const n = stack.pop();
        if (!n) continue;
        if (n.type === "import_spec") {
          const p = importPath(n);
          if (p) {
            ctx.edges.push({
              from: ctx.filePath,
              to_name: p,
              to_path: p,
              kind: "imports",
            });
          }
          continue;
        }
        for (const c of n.namedChildren) stack.push(c);
      }
      pushSymbol(ctx, node, node.text.split("\n")[0] ?? "import", "module");
      return;
    }
    case "function_declaration": {
      const name = node.childForFieldName("name")?.text ?? "<anonymous>";
      const id = pushSymbol(ctx, node, name, "function");
      const body = node.childForFieldName("body");
      if (body) collectCalls(ctx, id, body);
      return;
    }
    case "method_declaration": {
      // Methods have a `receiver` field with parameter_list whose
      // parameter_declaration's `type` is the receiver type (possibly *T).
      const receiver = node.childForFieldName("receiver");
      let receiverName = "<recv>";
      if (receiver) {
        // Find the first type identifier under the receiver.
        const stack: Node[] = [receiver];
        while (stack.length > 0) {
          const n = stack.pop();
          if (!n) continue;
          if (n.type === "type_identifier") {
            receiverName = n.text;
            break;
          }
          for (const c of n.namedChildren) stack.push(c);
        }
      }
      const name = node.childForFieldName("name")?.text ?? "<anonymous>";
      const range = toRange(node.startPosition, node.endPosition);
      const qname = qualifiedName(ctx.filePath, [receiverName], name);
      // POST-§20 fix (Issue A): canonical id is the qname.
      const id = qname;
      const sig = firstLine(node.text);
      ctx.symbols.push({
        symbol: qname,
        path: ctx.filePath,
        range,
        language: "go",
        kind: "method",
        signature: sig.length > 0 ? sig : undefined,
        docstring: leadingDocstring(node),
      });
      const body = node.childForFieldName("body");
      if (body) collectCalls(ctx, id, body);
      return;
    }
    case "type_declaration": {
      for (const spec of node.namedChildren) {
        if (spec.type !== "type_spec" && spec.type !== "type_alias") continue;
        const name = spec.childForFieldName("name")?.text ?? "<anonymous>";
        // Determine kind from type
        const ty = spec.childForFieldName("type");
        let kind: LodestoneSymbolType["kind"] = "type";
        if (ty?.type === "struct_type") {
          // §02 SymbolKind has no "struct"; collapse to "type" (Go's struct is a nominal type).
          kind = "type";
        } else if (ty?.type === "interface_type") {
          kind = "interface";
        }
        // Push under the type_spec node so the range is tight.
        pushSymbol(ctx, spec, name, kind);
      }
      return;
    }
    default:
      return;
  }
}

export const GoParser: AbstractParser = {
  language: "go",
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
      const parser = await getParser("go");
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

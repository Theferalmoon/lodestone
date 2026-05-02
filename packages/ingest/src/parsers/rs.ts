// SPDX-License-Identifier: Apache-2.0
// Rust parser. Extracts fn/struct/enum/trait/type/use + calls/imports/implements.
// Emits ClassInheritance triples for `impl Trait for Struct` (the implementer
// is the deriving "class", the trait is the base).

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
  while (cursor && (cursor.type === "line_comment" || cursor.type === "block_comment")) {
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
    language: "rust",
    kind,
    signature: sig.length > 0 ? sig : undefined,
    docstring: leadingDocstring(node),
  });
  return id;
}

/**
 * Rust node types that own a separately-surfaced `LodestoneSymbol`. Skip
 * inside `collectCalls` so calls in nested fn/impl/etc. don't get attributed
 * to the outer fn body (RED §06 #1). Closures (`closure_expression`) stay in
 * scope — they're inline and not surfaced as separate symbols today.
 */
const RS_NESTED_SYMBOL_TYPES = new Set<string>([
  "function_item",
  "impl_item",
  "struct_item",
  "enum_item",
  "trait_item",
  "type_item",
]);

function collectCalls(ctx: Ctx, fromId: string, root: Node): void {
  const stack: Node[] = [];
  for (const c of root.namedChildren) stack.push(c);
  while (stack.length > 0) {
    const n = stack.pop();
    if (!n) continue;
    if (RS_NESTED_SYMBOL_TYPES.has(n.type)) continue;
    if (n.type === "call_expression") {
      const fn = n.childForFieldName("function");
      if (fn) {
        let target = fn.text;
        if (fn.type === "field_expression") {
          target = fn.childForFieldName("field")?.text ?? fn.text;
        } else if (fn.type === "scoped_identifier") {
          // foo::bar — record rightmost segment
          const parts = fn.text.split("::");
          target = parts[parts.length - 1] ?? fn.text;
        }
        ctx.edges.push({ from: fromId, to_name: target, kind: "calls" });
      }
    }
    for (const c of n.namedChildren) stack.push(c);
  }
}

function useText(node: Node): string {
  // Strip the trailing semicolon and `use ` prefix for a cleaner edge name.
  return node.text.replace(/^use\s+/, "").replace(/;\s*$/, "").trim();
}

function walk(ctx: Ctx, node: Node): void {
  switch (node.type) {
    case "use_declaration": {
      const name = useText(node);
      ctx.edges.push({
        from: ctx.filePath,
        to_name: name,
        to_path: name,
        kind: "imports",
      });
      pushSymbol(ctx, node, name, "module");
      return;
    }
    case "function_item": {
      const name = node.childForFieldName("name")?.text ?? "<anonymous>";
      const id = pushSymbol(ctx, node, name, "function");
      const body = node.childForFieldName("body");
      if (body) collectCalls(ctx, id, body);
      // Codex r2 §06 PARTIAL: re-enter so nested fn / impl / etc. inside the
      // body are surfaced as their own symbols and their internal calls are
      // attributed correctly. The collectCalls() boundary stops the outer
      // attribution; this re-walk recovers the nested-symbol pass.
      const inner: Ctx = { ...ctx, parents: [...ctx.parents, name] };
      if (body) for (const c of body.namedChildren) walk(inner, c);
      return;
    }
    case "struct_item": {
      const name = node.childForFieldName("name")?.text ?? "<anonymous>";
      pushSymbol(ctx, node, name, "type");
      return;
    }
    case "enum_item": {
      const name = node.childForFieldName("name")?.text ?? "<anonymous>";
      pushSymbol(ctx, node, name, "type");
      return;
    }
    case "trait_item": {
      const name = node.childForFieldName("name")?.text ?? "<anonymous>";
      pushSymbol(ctx, node, name, "interface");
      return;
    }
    case "type_item": {
      const name = node.childForFieldName("name")?.text ?? "<anonymous>";
      pushSymbol(ctx, node, name, "type");
      return;
    }
    case "impl_item": {
      // Two shapes:
      //   impl T for S { … }   → trait field = T, type field = S, body = declaration_list
      //   impl S { … }         → type field = S, body = declaration_list
      const traitNode = node.childForFieldName("trait");
      const typeNode = node.childForFieldName("type");
      const targetType = typeNode?.text ?? "<unknown>";
      const range = toRange(node.startPosition, node.endPosition);

      if (traitNode) {
        // Synthesize an impl-block symbol so callers can attach inheritance to it.
        const traitName = traitNode.text;
        const implName = `impl_${traitName}_for_${targetType}`;
        const qname = qualifiedName(ctx.filePath, ctx.parents, implName);
        // POST-§20 fix (Issue A): canonical id is the qname.
        const implId = qname;
        const sig = firstLine(node.text);
        ctx.symbols.push({
          symbol: qname,
          path: ctx.filePath,
          range,
          language: "rust",
          kind: "type",
          signature: sig.length > 0 ? sig : undefined,
          docstring: leadingDocstring(node),
        });
        ctx.edges.push({ from: implId, to_name: traitName, kind: "implements" });
        // Inheritance triple: implementer-symbol → trait
        ctx.class_inheritance.push({ class_id: implId, base_name: traitName });
      }

      const body = node.childForFieldName("body");
      if (body) {
        const inner: Ctx = { ...ctx, parents: [...ctx.parents, targetType] };
        for (const member of body.namedChildren) {
          if (member.type === "function_item") {
            const mName = member.childForFieldName("name")?.text ?? "<anonymous>";
            const mRange = toRange(member.startPosition, member.endPosition);
            const mQname = qualifiedName(ctx.filePath, [...inner.parents], mName);
            // POST-§20 fix (Issue A): canonical id is the qname.
            const mId = mQname;
            const sig = firstLine(member.text);
            ctx.symbols.push({
              symbol: mQname,
              path: ctx.filePath,
              range: mRange,
              language: "rust",
              kind: "method",
              signature: sig.length > 0 ? sig : undefined,
              docstring: leadingDocstring(member),
            });
            const mBody = member.childForFieldName("body");
            if (mBody) collectCalls(ctx, mId, mBody);
            // Codex r2 §06 PARTIAL: re-enter the method body so nested fn
            // declarations (e.g. local helper fns inside an impl method) are
            // surfaced and their calls are attributed to them, not lost.
            const methodInner: Ctx = {
              ...ctx,
              parents: [...inner.parents, mName],
            };
            if (mBody) for (const c of mBody.namedChildren) walk(methodInner, c);
          }
        }
      }
      return;
    }
    default:
      return;
  }
}

export const RustParser: AbstractParser = {
  language: "rust",
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
      const parser = await getParser("rust");
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
    addFileAsModuleSymbolIfNeeded(ctx.symbols, ctx.edges, filePath, "rust");
    return ctx;
  },
};

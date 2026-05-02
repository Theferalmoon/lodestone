// SPDX-License-Identifier: Apache-2.0
// TypeScript parser tests using the real WASM grammar + sample.ts/sample.tsx fixtures.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { TypeScriptParser } from "../ts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, "../__fixtures__");

describe("TypeScriptParser", () => {
  it("extracts top-level function, class, methods, and import from sample.ts", async () => {
    const src = readFileSync(path.join(FIXTURES, "sample.ts"), "utf8");
    const r = await TypeScriptParser.parse("src/sample.ts", src);

    expect(r.warnings).toEqual([]);

    const byKind = (k: string) => r.symbols.filter((s) => s.kind === k);
    expect(byKind("function").length).toBe(1);
    expect(byKind("class").length).toBe(1);
    expect(byKind("method").length).toBe(2);
    expect(byKind("module").length).toBeGreaterThanOrEqual(1);

    const fn = byKind("function")[0]!;
    expect(fn.symbol).toBe("src/sample.ts::topLevel");
    expect(fn.range.start_line).toBeGreaterThan(0);

    const cls = byKind("class")[0]!;
    expect(cls.symbol).toBe("src/sample.ts::User");

    const methods = byKind("method").map((m) => m.symbol).sort();
    expect(methods).toEqual([
      "src/sample.ts::User::greet",
      "src/sample.ts::User::login",
    ]);
  });

  it("emits an `imports` edge for each import_statement", async () => {
    const src = readFileSync(path.join(FIXTURES, "sample.ts"), "utf8");
    const r = await TypeScriptParser.parse("src/sample.ts", src);
    const imports = r.edges.filter((e) => e.kind === "imports");
    expect(imports.length).toBeGreaterThanOrEqual(1);
    expect(imports[0]!.to_path).toBe("./helper");
  });

  it("emits `calls` edges from inside method bodies", async () => {
    const src = readFileSync(path.join(FIXTURES, "sample.ts"), "utf8");
    const r = await TypeScriptParser.parse("src/sample.ts", src);
    const calls = r.edges.filter((e) => e.kind === "calls");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some((c) => c.to_name === "helper")).toBe(true);
  });

  it("emits class_inheritance triples + extends/implements edges", async () => {
    const src = `class Sub extends Base implements Iface, Other {}\n`;
    const r = await TypeScriptParser.parse("src/x.ts", src);
    const ext = r.edges.filter((e) => e.kind === "extends");
    const impl = r.edges.filter((e) => e.kind === "implements");
    expect(ext.length).toBe(1);
    expect(ext[0]!.to_name).toBe("Base");
    expect(impl.map((e) => e.to_name).sort()).toEqual(["Iface", "Other"]);
    // POST-CODEX-001 amendment §1
    expect(r.class_inheritance.length).toBe(3);
    const baseNames = r.class_inheritance.map((t) => t.base_name).sort();
    expect(baseNames).toEqual(["Base", "Iface", "Other"]);
  });

  it("parses TSX as TypeScript with JSX (sample.tsx)", async () => {
    const src = readFileSync(path.join(FIXTURES, "sample.tsx"), "utf8");
    const r = await TypeScriptParser.parse("src/sample.tsx", src);
    expect(r.warnings).toEqual([]);
    const fn = r.symbols.find((s) => s.kind === "function" && s.symbol.endsWith("::Counter"));
    expect(fn).toBeTruthy();
    // useState() call inside the body should produce a calls edge.
    expect(r.edges.some((e) => e.kind === "calls" && e.to_name === "useState")).toBe(true);
  });

  it("surfaces interface/type/enum declarations", async () => {
    const src = `interface I { m(): void; }
type Alias = number;
enum E { A, B }
`;
    const r = await TypeScriptParser.parse("src/types.ts", src);
    expect(r.symbols.find((s) => s.kind === "interface")?.symbol).toBe("src/types.ts::I");
    expect(r.symbols.find((s) => s.kind === "type" && s.symbol.endsWith("::Alias"))).toBeTruthy();
    expect(r.symbols.find((s) => s.kind === "type" && s.symbol.endsWith("::E"))).toBeTruthy();
  });

  it("surfaces arrow functions assigned to top-level const", async () => {
    const src = `export const adder = (a: number, b: number) => a + b;\n`;
    const r = await TypeScriptParser.parse("src/u.ts", src);
    const fn = r.symbols.find((s) => s.kind === "function");
    expect(fn?.symbol).toBe("src/u.ts::adder");
  });

  it("emits ParserEdge.from as the source symbol's qname (POST-§20 Issue A)", async () => {
    // calls/extends/implements edges' `from` MUST equal a `LodestoneSymbol.symbol`
    // qname so resolveEdges + buildGraph see a single source of truth. Imports
    // edges keep `from = filePath` (they have no source symbol); the pipeline
    // driver drops those before graph build.
    const src = readFileSync(path.join(FIXTURES, "sample.ts"), "utf8");
    const r = await TypeScriptParser.parse("src/sample.ts", src);
    const symbolIds = new Set(r.symbols.map((s) => s.symbol));
    for (const edge of r.edges) {
      if (edge.kind === "imports") continue; // file-level, from = filePath
      expect(symbolIds.has(edge.from)).toBe(true);
    }
    // class_inheritance triples must reference a real class symbol id.
    const classInheritanceClassIds = new Set(r.class_inheritance.map((c) => c.class_id));
    for (const ci of classInheritanceClassIds) {
      expect(symbolIds.has(ci)).toBe(true);
    }
  });
});

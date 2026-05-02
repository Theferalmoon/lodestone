// SPDX-License-Identifier: Apache-2.0
// Go parser tests. No class inheritance in Go — we never emit triples.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { GoParser } from "../go.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, "../__fixtures__");

describe("GoParser", () => {
  it("extracts func, method, struct, interface, and import from sample.go", async () => {
    const src = readFileSync(path.join(FIXTURES, "sample.go"), "utf8");
    const r = await GoParser.parse("src/sample.go", src);
    expect(r.warnings).toEqual([]);

    const byKind = (k: string) => r.symbols.filter((s) => s.kind === k);
    // F + M = 2 (M is a method). The struct + interface are typed as "type" / "interface".
    expect(byKind("function").length).toBe(1);
    expect(byKind("method").length).toBe(1);
    expect(byKind("interface").length).toBe(1);
    // R struct → "type" (no "struct" kind in shared SymbolKind)
    expect(byKind("type").some((s) => s.symbol.endsWith("::R"))).toBe(true);

    expect(byKind("function")[0]!.symbol).toBe("src/sample.go::F");
    expect(byKind("method")[0]!.symbol).toBe("src/sample.go::R::M");
    expect(byKind("interface")[0]!.symbol).toBe("src/sample.go::Greeter");
  });

  it("extracts both fmt and strings from a grouped import block", async () => {
    const src = readFileSync(path.join(FIXTURES, "sample.go"), "utf8");
    const r = await GoParser.parse("src/sample.go", src);
    const importPaths = r.edges.filter((e) => e.kind === "imports").map((e) => e.to_path).sort();
    expect(importPaths).toContain("fmt");
    expect(importPaths).toContain("strings");
  });

  it("emits calls edges from inside method bodies", async () => {
    const src = readFileSync(path.join(FIXTURES, "sample.go"), "utf8");
    const r = await GoParser.parse("src/sample.go", src);
    const calls = r.edges.filter((e) => e.kind === "calls");
    expect(calls.some((c) => c.to_name === "Println")).toBe(true);
    expect(calls.some((c) => c.to_name === "ToUpper")).toBe(true);
  });

  it("never emits class_inheritance triples (Go has no inheritance)", async () => {
    const src = readFileSync(path.join(FIXTURES, "sample.go"), "utf8");
    const r = await GoParser.parse("src/sample.go", src);
    expect(r.class_inheritance).toEqual([]);
  });

  it("handles a simple `import \"fmt\"` (non-grouped) form", async () => {
    const src = `package main\nimport "fmt"\nfunc G() { fmt.Println("hi") }\n`;
    const r = await GoParser.parse("src/g.go", src);
    expect(r.edges.find((e) => e.kind === "imports")?.to_path).toBe("fmt");
  });
});

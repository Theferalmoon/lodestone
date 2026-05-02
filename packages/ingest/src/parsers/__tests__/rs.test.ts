// SPDX-License-Identifier: Apache-2.0
// Rust parser tests including `impl Trait for Struct` inheritance triple (amendment §1).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { RustParser } from "../rs.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, "../__fixtures__");

describe("RustParser", () => {
  it("extracts fn, struct, trait, impl-method, and use from sample.rs", async () => {
    const src = readFileSync(path.join(FIXTURES, "sample.rs"), "utf8");
    const r = await RustParser.parse("src/sample.rs", src);
    expect(r.warnings).toEqual([]);

    const byKind = (k: string) => r.symbols.filter((s) => s.kind === k);
    // f + _unused = 2 top-level fns
    expect(byKind("function").length).toBe(2);
    // method t inside `impl T for S`
    expect(byKind("method").length).toBe(1);
    // struct S → "type" (no struct in shared SymbolKind)
    expect(byKind("type").some((s) => s.symbol.endsWith("::S"))).toBe(true);
    // trait T → "interface"
    expect(byKind("interface").some((s) => s.symbol.endsWith("::T"))).toBe(true);

    // The method's qualified name should include the impl target type
    const method = byKind("method")[0]!;
    expect(method.symbol).toBe("src/sample.rs::S::t");
  });

  it("emits implements edge + class_inheritance triple for `impl T for S` (amendment §1)", async () => {
    const src = readFileSync(path.join(FIXTURES, "sample.rs"), "utf8");
    const r = await RustParser.parse("src/sample.rs", src);
    const impl = r.edges.filter((e) => e.kind === "implements");
    expect(impl.length).toBe(1);
    expect(impl[0]!.to_name).toBe("T");
    expect(r.class_inheritance.length).toBe(1);
    expect(r.class_inheritance[0]!.base_name).toBe("T");
  });

  it("emits import edges for `use` declarations", async () => {
    const src = readFileSync(path.join(FIXTURES, "sample.rs"), "utf8");
    const r = await RustParser.parse("src/sample.rs", src);
    const imports = r.edges.filter((e) => e.kind === "imports");
    expect(imports.length).toBeGreaterThanOrEqual(1);
    expect(imports[0]!.to_name).toBe("std::io");
  });

  it("does not emit a class_inheritance triple for inherent impl (impl S { … })", async () => {
    const src = `struct S;
impl S { fn m(&self) {} }
`;
    const r = await RustParser.parse("src/u.rs", src);
    expect(r.class_inheritance).toEqual([]);
    // The method should still be recorded.
    expect(r.symbols.find((s) => s.kind === "method" && s.symbol === "src/u.rs::S::m")).toBeTruthy();
  });

  it("emits a calls edge from inside fn body (`s.t()` → call to `t`)", async () => {
    const src = readFileSync(path.join(FIXTURES, "sample.rs"), "utf8");
    const r = await RustParser.parse("src/sample.rs", src);
    expect(r.edges.some((e) => e.kind === "calls" && e.to_name === "t")).toBe(true);
  });

  it("extracts enum_item as kind 'type'", async () => {
    const src = `enum E { A, B }\n`;
    const r = await RustParser.parse("src/e.rs", src);
    expect(r.symbols.find((s) => s.kind === "type" && s.symbol.endsWith("::E"))).toBeTruthy();
  });

  it("extracts type_item alias", async () => {
    const src = `type Alias = i32;\n`;
    const r = await RustParser.parse("src/t.rs", src);
    expect(r.symbols.find((s) => s.kind === "type" && s.symbol.endsWith("::Alias"))).toBeTruthy();
  });

  it("attributes nested fn calls to the inner fn, not the outer (RED §06 r2)", async () => {
    // outer { inner() { foo() } bar() } — `foo` belongs to inner, NOT outer.
    // Pre-r2 the nested `function_item` was skipped without re-entry, so
    // `foo()` was simply lost (not just misattributed).
    const src = `fn outer() {
  fn inner() {
    foo();
  }
  bar();
}
`;
    const r = await RustParser.parse("src/nest.rs", src);
    const calls = r.edges.filter((e) => e.kind === "calls");
    const outerId = "src/nest.rs::outer";
    const innerId = "src/nest.rs::outer::inner";
    const outerCalls = calls.filter((c) => c.from === outerId).map((c) => c.to_name).sort();
    expect(outerCalls).toEqual(["bar"]);
    const innerCalls = calls.filter((c) => c.from === innerId).map((c) => c.to_name).sort();
    expect(innerCalls).toEqual(["foo"]);
    // The nested fn must also be surfaced as its own symbol.
    expect(r.symbols.find((s) => s.kind === "function" && s.symbol === innerId)).toBeTruthy();
  });

  it("attributes calls inside an impl method's nested fn to the nested fn, not the method (RED §06 r2)", async () => {
    const src = `struct S;
impl S {
  fn m(&self) {
    hello();
    fn nested() { inside(); }
  }
}
`;
    const r = await RustParser.parse("src/im.rs", src);
    const calls = r.edges.filter((e) => e.kind === "calls");
    const methodId = "src/im.rs::S::m";
    const nestedId = "src/im.rs::S::m::nested";
    const methodCalls = calls.filter((c) => c.from === methodId).map((c) => c.to_name).sort();
    expect(methodCalls).toEqual(["hello"]);
    const nestedCalls = calls.filter((c) => c.from === nestedId).map((c) => c.to_name).sort();
    expect(nestedCalls).toEqual(["inside"]);
    expect(
      r.symbols.find((s) => s.kind === "function" && s.symbol === nestedId),
    ).toBeTruthy();
  });
});

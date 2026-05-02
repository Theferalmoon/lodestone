// SPDX-License-Identifier: Apache-2.0
// JavaScript parser smoke test using sample.js + a small inline class.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { JavaScriptParser } from "../js.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, "../__fixtures__");

describe("JavaScriptParser", () => {
  it("extracts function, class, method, ESM import, and CommonJS require", async () => {
    const src = readFileSync(path.join(FIXTURES, "sample.js"), "utf8");
    const r = await JavaScriptParser.parse("src/sample.js", src);

    expect(r.warnings).toEqual([]);

    const byKind = (k: string) => r.symbols.filter((s) => s.kind === k);
    expect(byKind("function").length).toBe(1);
    expect(byKind("class").length).toBe(1);
    expect(byKind("method").length).toBe(1);

    const fn = byKind("function")[0]!;
    expect(fn.symbol).toBe("src/sample.js::topLevel");
    const m = byKind("method")[0]!;
    expect(m.symbol).toBe("src/sample.js::User::greet");

    const imports = r.edges.filter((e) => e.kind === "imports");
    // ESM `./helper.js` + CommonJS `fs`
    const sources = imports.map((e) => e.to_path).sort();
    expect(sources).toContain("./helper.js");
    expect(sources).toContain("fs");
  });

  it("emits an extends edge + class_inheritance triple for `class A extends B`", async () => {
    const src = `class A extends B {}\n`;
    const r = await JavaScriptParser.parse("src/a.js", src);
    expect(r.edges.filter((e) => e.kind === "extends").map((e) => e.to_name)).toEqual(["B"]);
    expect(r.class_inheritance).toEqual([
      { class_id: expect.any(String), base_name: "B" },
    ]);
  });

  it("emits a calls edge from inside a function body", async () => {
    const src = `function f() { foo(1); }\n`;
    const r = await JavaScriptParser.parse("src/c.js", src);
    expect(r.edges.some((e) => e.kind === "calls" && e.to_name === "foo")).toBe(true);
  });

  it("attributes nested function calls to the inner fn, not the outer (RED §06 r2)", async () => {
    // Pre-r2 the nested `function_declaration` was skipped without re-entry,
    // so `foo()` was lost entirely.
    const src = `function outer() {
  function inner() {
    foo();
  }
  bar();
}
`;
    const r = await JavaScriptParser.parse("src/nest.js", src);
    const calls = r.edges.filter((e) => e.kind === "calls");
    const outerId = "src/nest.js::outer";
    const innerId = "src/nest.js::outer::inner";
    const outerCalls = calls.filter((c) => c.from === outerId).map((c) => c.to_name).sort();
    expect(outerCalls).toEqual(["bar"]);
    const innerCalls = calls.filter((c) => c.from === innerId).map((c) => c.to_name).sort();
    expect(innerCalls).toEqual(["foo"]);
    expect(r.symbols.find((s) => s.kind === "function" && s.symbol === innerId)).toBeTruthy();
  });

  it("attributes calls inside class methods to the method, not into a nested function inside the body (RED §06 r2)", async () => {
    const src = `class C {
  greet() {
    hello();
    function nested() { inside(); }
  }
}
`;
    const r = await JavaScriptParser.parse("src/cm.js", src);
    const calls = r.edges.filter((e) => e.kind === "calls");
    const methodId = "src/cm.js::C::greet";
    const nestedId = "src/cm.js::C::greet::nested";
    const methodCalls = calls.filter((c) => c.from === methodId).map((c) => c.to_name).sort();
    expect(methodCalls).toEqual(["hello"]);
    const nestedCalls = calls.filter((c) => c.from === nestedId).map((c) => c.to_name).sort();
    expect(nestedCalls).toEqual(["inside"]);
    expect(r.symbols.find((s) => s.kind === "function" && s.symbol === nestedId)).toBeTruthy();
  });

  it("keeps inline arrow callbacks attributing calls to the surrounding function (RED §06 r2 regression guard)", async () => {
    const src = `function outer() {
  [1,2,3].map(x => doThing(x));
}
`;
    const r = await JavaScriptParser.parse("src/inline.js", src);
    const calls = r.edges.filter((e) => e.kind === "calls");
    const outerCalls = calls
      .filter((c) => c.from === "src/inline.js::outer")
      .map((c) => c.to_name)
      .sort();
    expect(outerCalls).toEqual(["doThing", "map"]);
  });
});

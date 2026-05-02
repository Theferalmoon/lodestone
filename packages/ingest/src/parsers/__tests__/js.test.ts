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
});

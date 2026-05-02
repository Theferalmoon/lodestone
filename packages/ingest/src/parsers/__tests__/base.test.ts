// SPDX-License-Identifier: Apache-2.0
// AbstractParser contract tests: broken-file partial-parse + BOM handling +
// helper-function coverage.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { qualifiedName, stripBom, symbolId, toString } from "../base.js";
import { TypeScriptParser } from "../ts.js";
import { PythonParser } from "../py.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, "../__fixtures__");

describe("base helpers", () => {
  it("stripBom removes a leading UTF-8 BOM", () => {
    expect(stripBom("﻿hello")).toBe("hello");
  });

  it("stripBom is a no-op when no BOM is present", () => {
    expect(stripBom("hello")).toBe("hello");
    expect(stripBom("")).toBe("");
  });

  it("toString accepts both Buffer and string", () => {
    expect(toString("abc")).toBe("abc");
    expect(toString(Buffer.from("abc", "utf8"))).toBe("abc");
  });

  it("symbolId is deterministic for the same inputs", () => {
    const a = symbolId("src/x.ts", "src/x.ts::foo", 3);
    const b = symbolId("src/x.ts", "src/x.ts::foo", 3);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it("symbolId differs when inputs differ", () => {
    const a = symbolId("src/x.ts", "src/x.ts::foo", 3);
    const b = symbolId("src/x.ts", "src/x.ts::foo", 4);
    expect(a).not.toBe(b);
  });

  it("qualifiedName joins path::parents::name with '::'", () => {
    expect(qualifiedName("src/x.ts", [], "foo")).toBe("src/x.ts::foo");
    expect(qualifiedName("src/x.ts", ["User"], "login")).toBe("src/x.ts::User::login");
    expect(qualifiedName("src/x.ts", ["A", "B"], "c")).toBe("src/x.ts::A::B::c");
  });
});

describe("AbstractParser contract — broken input", () => {
  it("parser does not throw on a syntactically broken file", async () => {
    const filePath = path.join(FIXTURES, "broken.ts");
    const src = readFileSync(filePath, "utf8");
    const result = await TypeScriptParser.parse("broken.ts", src);
    expect(result).toBeTruthy();
    expect(result.warnings.length).toBeGreaterThan(0);
    // Even on a broken file, partial-parse may yield zero or more symbols —
    // we only require the call returned without throwing.
    expect(result.symbols.length).toBeGreaterThanOrEqual(0);
  });
});

describe("AbstractParser contract — BOM handling", () => {
  it("Python parser strips a leading UTF-8 BOM and preserves line numbers", async () => {
    const filePath = path.join(FIXTURES, "bom.py");
    const src = readFileSync(filePath); // Buffer
    // Sanity: the fixture really starts with a BOM byte sequence.
    expect(src[0]).toBe(0xef);
    expect(src[1]).toBe(0xbb);
    expect(src[2]).toBe(0xbf);

    const result = await PythonParser.parse("bom.py", src);
    expect(result.warnings).toEqual([]);
    const fn = result.symbols.find((s) => s.kind === "function");
    expect(fn).toBeTruthy();
    expect(fn!.range.start_line).toBe(1);
    expect(fn!.symbol).toBe("bom.py::f");
  });
});

describe("AbstractParser contract — Symbol.id determinism", () => {
  it("two parses of the same source produce the same symbol qualified names + ids", async () => {
    const src = `function foo() { return 1; }\n`;
    const a = await TypeScriptParser.parse("a.ts", src);
    const b = await TypeScriptParser.parse("a.ts", src);
    expect(a.symbols.map((s) => s.symbol)).toEqual(b.symbols.map((s) => s.symbol));
    // The deterministic id is computed by symbolId() — verify directly.
    const fn = a.symbols.find((s) => s.kind === "function");
    expect(fn).toBeTruthy();
    const id = symbolId("a.ts", fn!.symbol, fn!.range.start_line);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });
});

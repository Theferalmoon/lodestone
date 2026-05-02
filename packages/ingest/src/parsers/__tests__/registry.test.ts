// SPDX-License-Identifier: Apache-2.0
// Registry tests — parserForFile() returns the right parser for each
// supported extension and null otherwise.

import { describe, expect, it } from "vitest";

import {
  GoParser,
  JavaScriptParser,
  parserForFile,
  PythonParser,
  RustParser,
  TypeScriptParser,
} from "../index.js";

describe("parserForFile", () => {
  it("maps each supported extension to its parser", () => {
    expect(parserForFile("a.ts")).toBe(TypeScriptParser);
    expect(parserForFile("a.tsx")).toBe(TypeScriptParser);
    expect(parserForFile("a.js")).toBe(JavaScriptParser);
    expect(parserForFile("a.jsx")).toBe(JavaScriptParser);
    expect(parserForFile("a.mjs")).toBe(JavaScriptParser);
    expect(parserForFile("a.cjs")).toBe(JavaScriptParser);
    expect(parserForFile("a.py")).toBe(PythonParser);
    expect(parserForFile("a.pyi")).toBe(PythonParser);
    expect(parserForFile("a.go")).toBe(GoParser);
    expect(parserForFile("a.rs")).toBe(RustParser);
  });

  it("returns null for unknown extensions", () => {
    expect(parserForFile("a.unknown")).toBeNull();
    expect(parserForFile("README.md")).toBeNull();
    expect(parserForFile("noext")).toBeNull();
    expect(parserForFile("a.txt")).toBeNull();
  });

  it("is case-insensitive on the extension", () => {
    expect(parserForFile("FOO.TS")).toBe(TypeScriptParser);
    expect(parserForFile("Bar.PY")).toBe(PythonParser);
    expect(parserForFile("bAz.Go")).toBe(GoParser);
    expect(parserForFile("Baz.RS")).toBe(RustParser);
    expect(parserForFile("Quux.MJS")).toBe(JavaScriptParser);
  });

  it("works with full paths, not just basenames", () => {
    expect(parserForFile("/abs/path/to/foo.ts")).toBe(TypeScriptParser);
    expect(parserForFile("rel/path/to/foo.py")).toBe(PythonParser);
  });
});

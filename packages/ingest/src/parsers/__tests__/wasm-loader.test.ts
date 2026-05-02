// SPDX-License-Identifier: Apache-2.0
// wasm-loader smoke + memoization tests. Uses real WASM (no mocking) — the
// grammars are tiny and load in milliseconds.

import { afterEach, describe, expect, it } from "vitest";

import {
  _resetWasmLoaderState,
  ensureRuntimeReady,
  getParser,
  loadLanguage,
} from "../wasm-loader.js";

describe("wasm-loader", () => {
  afterEach(() => {
    // We deliberately do NOT reset between tests in this file — caching is
    // process-global on purpose. But after the last test we clean up so other
    // test files can rely on a fresh state if they want to.
  });

  it("ensureRuntimeReady() is idempotent across repeated calls", async () => {
    await ensureRuntimeReady();
    await ensureRuntimeReady();
    await ensureRuntimeReady();
    // No throw == pass. Also test the underlying promise identity.
    const a = ensureRuntimeReady();
    const b = ensureRuntimeReady();
    expect(a).toBe(b);
  });

  it("loadLanguage() memoizes per-language", async () => {
    const a = await loadLanguage("python");
    const b = await loadLanguage("python");
    expect(a).toBe(b);
  });

  it("loadLanguage() returns distinct instances for different languages", async () => {
    const py = await loadLanguage("python");
    const ts = await loadLanguage("typescript");
    expect(py).not.toBe(ts);
  });

  it("loadLanguage() handles all six supported languages", async () => {
    for (const lang of ["typescript", "tsx", "javascript", "python", "go", "rust"] as const) {
      const lang_ = await loadLanguage(lang);
      expect(lang_).toBeTruthy();
    }
  });

  it("getParser() returns a parser bound to the requested language", async () => {
    const parser = await getParser("typescript");
    expect(parser).toBeTruthy();
    const tree = parser.parse("function f() {}");
    expect(tree).not.toBeNull();
    expect(tree!.rootNode.type).toBe("program");
  });

  it("getParser() memoizes per language", async () => {
    const a = await getParser("python");
    const b = await getParser("python");
    expect(a).toBe(b);
  });

  it("after _resetWasmLoaderState, loadLanguage returns a fresh instance", async () => {
    const before = await loadLanguage("go");
    _resetWasmLoaderState();
    const after = await loadLanguage("go");
    expect(after).not.toBe(before);
  });
});

// SPDX-License-Identifier: Apache-2.0
// One-shot Parser.init() + per-language Language.load(wasmPath) cache.
// `web-tree-sitter` requires init() to resolve before any `new Parser()` call;
// we memoize that promise plus each Language load so the WASM is decoded once
// per process per grammar.

import { createRequire } from "node:module";
import { Parser, Language } from "web-tree-sitter";

export type SupportedLanguage =
  | "typescript"
  | "tsx"
  | "javascript"
  | "python"
  | "go"
  | "rust";

// `import.meta.resolve` is async + flag-gated on older Node, so we use the
// CommonJS-style `require.resolve` shim. This is what tree-sitter's own
// docs recommend for resolving the bundled .wasm files at runtime.
const requireFromHere = createRequire(import.meta.url);

const WASM_SPECIFIERS: Record<SupportedLanguage, string> = {
  typescript: "tree-sitter-typescript/tree-sitter-typescript.wasm",
  tsx: "tree-sitter-typescript/tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript/tree-sitter-javascript.wasm",
  python: "tree-sitter-python/tree-sitter-python.wasm",
  go: "tree-sitter-go/tree-sitter-go.wasm",
  rust: "tree-sitter-rust/tree-sitter-rust.wasm",
};

let initPromise: Promise<void> | null = null;
const languageCache = new Map<SupportedLanguage, Promise<Language>>();
const parserCache = new Map<SupportedLanguage, Promise<Parser>>();

/**
 * Idempotent. Resolves once per process. Concurrent callers fold into the
 * same in-flight promise, so we never re-init the WASM runtime.
 */
export function ensureRuntimeReady(): Promise<void> {
  if (!initPromise) {
    initPromise = Parser.init();
  }
  return initPromise;
}

/**
 * Returns a memoized Language. Loads the WASM the first time it's asked for;
 * subsequent calls return the same instance.
 */
export function loadLanguage(lang: SupportedLanguage): Promise<Language> {
  let cached = languageCache.get(lang);
  if (!cached) {
    cached = (async () => {
      await ensureRuntimeReady();
      const wasmPath = requireFromHere.resolve(WASM_SPECIFIERS[lang]);
      return Language.load(wasmPath);
    })();
    languageCache.set(lang, cached);
  }
  return cached;
}

/**
 * Convenience: returns a cached Parser instance bound to the given language.
 * Tree-sitter parsers are cheap (just a small wrapper around the loaded
 * language) and stateless across `parse()` calls, so one-per-language is safe.
 */
export function getParser(lang: SupportedLanguage): Promise<Parser> {
  let cached = parserCache.get(lang);
  if (!cached) {
    cached = (async () => {
      const language = await loadLanguage(lang);
      const parser = new Parser();
      parser.setLanguage(language);
      return parser;
    })();
    parserCache.set(lang, cached);
  }
  return cached;
}

/**
 * Test-only: clear all memoized state. NOT exported from the package surface;
 * tests import it directly via the relative path.
 */
export function _resetWasmLoaderState(): void {
  initPromise = null;
  languageCache.clear();
  parserCache.clear();
}

// SPDX-License-Identifier: Apache-2.0
// File-extension → parser registry. Returns null for unsupported extensions
// so the ingest worker can skip silently.

import path from "node:path";

import type { AbstractParser } from "./base.js";
import { TypeScriptParser } from "./ts.js";
import { JavaScriptParser } from "./js.js";
import { PythonParser } from "./py.js";
import { GoParser } from "./go.js";
import { RustParser } from "./rs.js";

export { TypeScriptParser } from "./ts.js";
export { JavaScriptParser } from "./js.js";
export { PythonParser } from "./py.js";
export { GoParser } from "./go.js";
export { RustParser } from "./rs.js";

export type {
  AbstractParser,
  ParseResult,
  ParserEdge,
  ClassInheritance,
} from "./base.js";

export function parserForFile(filePath: string): AbstractParser | null {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".ts":
    case ".tsx":
      return TypeScriptParser;
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return JavaScriptParser;
    case ".py":
    case ".pyi":
      return PythonParser;
    case ".go":
      return GoParser;
    case ".rs":
      return RustParser;
    default:
      return null;
  }
}

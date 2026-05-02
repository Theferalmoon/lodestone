// SPDX-License-Identifier: Apache-2.0
// §07 RED #1 round-trip: parse → resolveEdges → buildGraph must preserve
// import edges so the §15 `context()` tool can populate `imports_from` /
// `imported_by`. The previous design dropped every parser-emitted import
// edge because its `from` was a file path (not a known symbol id), so
// downstream import context was systematically empty.
//
// The fix at the §06 layer: each parser emits a synthetic file-as-module
// `LodestoneSymbol` per parsed file (id == filePath) so `from = filePath`
// resolves cleanly. This test is the regression guard for that contract.

import { describe, expect, it } from "vitest";

import { buildGraph } from "../builder.js";
import { resolveEdges } from "../resolve.js";
import { TypeScriptParser } from "../../parsers/ts.js";
import { PythonParser } from "../../parsers/py.js";

describe("§07 RED #1 — import edges round-trip", () => {
  it("TypeScript: imports edges survive resolveEdges + buildGraph", async () => {
    const src = `import { helper } from "./helper";
export function topLevel(a) { return helper(a); }
`;
    const r = await TypeScriptParser.parse("src/sample.ts", src);

    // Parser MUST emit a file-as-module symbol for the file itself so
    // `from = filePath` import edges resolve to a real graph node.
    const fileSym = r.symbols.find((s) => s.symbol === "src/sample.ts");
    expect(fileSym, "parser must emit a file-as-module symbol").toBeTruthy();
    expect(fileSym!.kind).toBe("module");
    expect(fileSym!.path).toBe("src/sample.ts");

    // The imports edge must reference that file symbol as `from`.
    const importsEdges = r.edges.filter((e) => e.kind === "imports");
    expect(importsEdges.length).toBeGreaterThanOrEqual(1);
    const fileImports = importsEdges.filter((e) => e.from === "src/sample.ts");
    expect(fileImports.length).toBeGreaterThanOrEqual(1);

    // Round-trip: resolveEdges + buildGraph keep the edge in the graph.
    const { edges } = resolveEdges({ symbols: r.symbols, edges: r.edges });
    const importEdgesAfterResolve = edges.filter((e) => e.kind === "imports");
    expect(importEdgesAfterResolve.length).toBeGreaterThanOrEqual(1);

    const graph = buildGraph({ symbols: r.symbols, edges: importEdgesAfterResolve });
    // The from node must exist as a real (not external) symbol node.
    expect(graph.hasNode("src/sample.ts")).toBe(true);
    expect(graph.getNodeAttribute("src/sample.ts", "external")).toBe(false);
    // At least one outbound imports edge from the file node.
    const out = graph.outEdges("src/sample.ts").map((eid) => graph.getEdgeAttributes(eid));
    expect(out.some((a) => a.kind === "imports")).toBe(true);
  });

  it("Python: imports edges survive resolveEdges + buildGraph", async () => {
    const src = `import os
def f():
    return os.getcwd()
`;
    const r = await PythonParser.parse("src/m.py", src);
    const fileSym = r.symbols.find((s) => s.symbol === "src/m.py");
    expect(fileSym, "parser must emit a file-as-module symbol").toBeTruthy();
    expect(fileSym!.kind).toBe("module");

    const importsEdges = r.edges.filter((e) => e.kind === "imports");
    expect(importsEdges.length).toBeGreaterThanOrEqual(1);
    expect(importsEdges.some((e) => e.from === "src/m.py")).toBe(true);

    const { edges } = resolveEdges({ symbols: r.symbols, edges: r.edges });
    const graph = buildGraph({
      symbols: r.symbols,
      edges: edges.filter((e) => e.kind === "imports"),
    });
    expect(graph.hasNode("src/m.py")).toBe(true);
    expect(graph.getNodeAttribute("src/m.py", "external")).toBe(false);
  });
});

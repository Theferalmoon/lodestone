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
  it("TypeScript: imports edges survive resolveEdges + buildGraph when both files are parsed", async () => {
    // Two files, src/sample.ts imports src/helper.ts. Both are parsed so
    // both file-as-module symbols + the helper export are in the symbol
    // set, and the import edge resolves to an internal node — surviving
    // the new default-internal-only buildGraph behaviour.
    const sampleSrc = `import { helper } from "./helper";
export function topLevel(a) { return helper(a); }
`;
    const helperSrc = `export function helper(a) { return a + 1; }
`;
    const sample = await TypeScriptParser.parse("src/sample.ts", sampleSrc);
    const helper = await TypeScriptParser.parse("src/helper.ts", helperSrc);
    const symbols = [...sample.symbols, ...helper.symbols];
    const edges = [...sample.edges, ...helper.edges];

    // Parser MUST emit a file-as-module symbol for the importing file so
    // `from = filePath` import edges resolve to a real graph node.
    const fileSym = symbols.find((s) => s.symbol === "src/sample.ts");
    expect(fileSym, "parser must emit a file-as-module symbol").toBeTruthy();
    expect(fileSym!.kind).toBe("module");
    expect(fileSym!.path).toBe("src/sample.ts");

    // The imports edge must reference that file symbol as `from`.
    const fileImports = edges.filter(
      (e) => e.kind === "imports" && e.from === "src/sample.ts",
    );
    expect(fileImports.length).toBeGreaterThanOrEqual(1);

    // Round-trip: resolveEdges + buildGraph keep the edge in the graph.
    const resolved = resolveEdges({ symbols, edges });
    const graph = buildGraph({
      symbols,
      edges: resolved.edges.filter((e) => e.kind === "imports" && e.resolved),
    });
    expect(graph.hasNode("src/sample.ts")).toBe(true);
    expect(graph.getNodeAttribute("src/sample.ts", "external")).toBe(false);
    // At least one outbound imports edge from the file node landed in the graph.
    const out = graph.outEdges("src/sample.ts").map((eid) => graph.getEdgeAttributes(eid));
    expect(out.some((a) => a.kind === "imports")).toBe(true);
  });

  it("Python: imports edges survive resolveEdges + buildGraph (with includeExternalStubs)", async () => {
    // Python's `import os` references a stdlib module that has no internal
    // symbol, so the edge target is external — opt into the stub flag to
    // verify the import edge survives the round-trip.
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
    const graph = buildGraph(
      {
        symbols: r.symbols,
        edges: edges.filter((e) => e.kind === "imports"),
      },
      { includeExternalStubs: true },
    );
    expect(graph.hasNode("src/m.py")).toBe(true);
    expect(graph.getNodeAttribute("src/m.py", "external")).toBe(false);
    // The "os" external import target lands as a stub when explicitly
    // asked for — proves the edge is preserved end-to-end through the
    // public API surface.
    const out = graph.outEdges("src/m.py").map((eid) => graph.getEdgeAttributes(eid));
    expect(out.some((a) => a.kind === "imports")).toBe(true);
  });
});

// SPDX-License-Identifier: Apache-2.0
// Python parser tests including class-inheritance triple emission (amendment §1).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PythonParser } from "../py.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, "../__fixtures__");

describe("PythonParser", () => {
  it("extracts def, class, methods, and both flavors of import", async () => {
    const src = readFileSync(path.join(FIXTURES, "sample.py"), "utf8");
    const r = await PythonParser.parse("src/sample.py", src);
    expect(r.warnings).toEqual([]);

    const byKind = (k: string) => r.symbols.filter((s) => s.kind === k);
    expect(byKind("function").length).toBe(1); // top-level foo
    expect(byKind("class").length).toBe(1); // Bar
    expect(byKind("method").length).toBe(1); // baz

    expect(byKind("function")[0]!.symbol).toBe("src/sample.py::foo");
    expect(byKind("method")[0]!.symbol).toBe("src/sample.py::Bar::baz");

    const imports = r.edges.filter((e) => e.kind === "imports");
    expect(imports.length).toBeGreaterThanOrEqual(2);
    const paths = imports.map((e) => e.to_path).sort();
    expect(paths).toContain("os");
    expect(paths).toContain("typing");
  });

  it("emits class_inheritance triple for `class Bar(Foo)` (amendment §1)", async () => {
    const src = readFileSync(path.join(FIXTURES, "sample.py"), "utf8");
    const r = await PythonParser.parse("src/sample.py", src);
    expect(r.class_inheritance.length).toBe(1);
    expect(r.class_inheritance[0]!.base_name).toBe("Foo");
    // The class_id should match an actual class symbol's deterministic id.
    const cls = r.symbols.find((s) => s.kind === "class")!;
    const expectedId = (await import("../base.js")).symbolId(
      "src/sample.py",
      cls.symbol,
      cls.range.start_line
    );
    expect(r.class_inheritance[0]!.class_id).toBe(expectedId);
  });

  it("emits a calls edge from method bodies", async () => {
    const src = readFileSync(path.join(FIXTURES, "sample.py"), "utf8");
    const r = await PythonParser.parse("src/sample.py", src);
    const calls = r.edges.filter((e) => e.kind === "calls");
    expect(calls.some((c) => c.to_name === "foo")).toBe(true);
    // os.getcwd() — we record rightmost attribute
    expect(calls.some((c) => c.to_name === "getcwd")).toBe(true);
  });

  it("handles multiple base classes — `class C(A, B)` produces two triples", async () => {
    const src = `class C(A, B):
    pass
`;
    const r = await PythonParser.parse("src/m.py", src);
    expect(r.class_inheritance.map((t) => t.base_name).sort()).toEqual(["A", "B"]);
  });
});

// SPDX-License-Identifier: Apache-2.0
// resolveEdges() tests — exact id, tail-name, path-hint, same-file fallback,
// ambiguous (kept unresolved), weight aggregation.

import { describe, expect, it } from "vitest";

import type { LodestoneSymbol } from "@lodestone/shared";

import type { ParserEdge } from "../../parsers/base.js";
import { resolveEdges } from "../resolve.js";

function sym(filePath: string, name: string): LodestoneSymbol {
  return {
    symbol: `${filePath}::${name}`,
    path: filePath,
    range: { start_line: 1, end_line: 1 },
    language: "typescript",
    kind: "function",
  };
}

describe("resolveEdges", () => {
  it("resolves an exact-id ParserEdge to itself", () => {
    const symbols = [sym("a.ts", "x"), sym("b.ts", "y")];
    const edges: ParserEdge[] = [
      { from: "a.ts::x", to_name: "b.ts::y", kind: "calls" },
    ];
    const { edges: resolved, unresolved } = resolveEdges({ symbols, edges });
    expect(unresolved).toEqual([]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.to).toBe("b.ts::y");
    expect(resolved[0]!.resolved).toBe(true);
  });

  it("resolves a bare tail name uniquely when only one candidate exists", () => {
    const symbols = [sym("a.ts", "x"), sym("b.ts", "y")];
    const edges: ParserEdge[] = [
      { from: "a.ts::x", to_name: "y", kind: "calls" },
    ];
    const { edges: resolved } = resolveEdges({ symbols, edges });
    expect(resolved[0]!.to).toBe("b.ts::y");
    expect(resolved[0]!.resolved).toBe(true);
  });

  it("uses to_path hint to disambiguate same-name candidates", () => {
    const symbols = [sym("a.ts", "x"), sym("b.ts", "shared"), sym("c.ts", "shared")];
    const edges: ParserEdge[] = [
      { from: "a.ts::x", to_name: "shared", to_path: "./b", kind: "calls" },
    ];
    const { edges: resolved } = resolveEdges({ symbols, edges });
    expect(resolved[0]!.to).toBe("b.ts::shared");
  });

  it("falls back to same-file when no to_path hint and the source file owns the name", () => {
    const symbols = [
      sym("a.ts", "caller"),
      sym("a.ts", "helper"),
      sym("b.ts", "helper"),
    ];
    const edges: ParserEdge[] = [
      { from: "a.ts::caller", to_name: "helper", kind: "calls" },
    ];
    const { edges: resolved } = resolveEdges({ symbols, edges });
    expect(resolved[0]!.to).toBe("a.ts::helper");
  });

  it("leaves an ambiguous tail name unresolved", () => {
    const symbols = [
      sym("a.ts", "callerOnly"),
      sym("b.ts", "shared"),
      sym("c.ts", "shared"),
    ];
    const edges: ParserEdge[] = [
      { from: "a.ts::callerOnly", to_name: "shared", kind: "calls" },
    ];
    const { edges: resolved, unresolved } = resolveEdges({ symbols, edges });
    expect(unresolved).toEqual(["shared"]);
    expect(resolved[0]!.resolved).toBe(false);
    expect(resolved[0]!.to).toBe("shared");
  });

  it("returns an unresolved entry (not dropped) for completely external targets", () => {
    const symbols = [sym("a.ts", "x")];
    const edges: ParserEdge[] = [
      { from: "a.ts::x", to_name: "lodash", kind: "imports" },
    ];
    const { edges: resolved, unresolved } = resolveEdges({ symbols, edges });
    expect(unresolved).toEqual(["lodash"]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.resolved).toBe(false);
  });

  it("aggregates weight when the same (from, to, kind) is emitted multiple times", () => {
    const symbols = [sym("a.ts", "x"), sym("a.ts", "y")];
    const edges: ParserEdge[] = [
      { from: "a.ts::x", to_name: "y", kind: "calls" },
      { from: "a.ts::x", to_name: "y", kind: "calls" },
      { from: "a.ts::x", to_name: "a.ts::y", kind: "calls" },
    ];
    const { edges: resolved } = resolveEdges({ symbols, edges });
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.weight).toBe(3);
  });

  it("does NOT silently match a file with the same basename in a different directory (RED §07 #2)", () => {
    // src/features/a.ts imports `../shared` — i.e. src/shared.
    // The previous resolver compared only basenames, so a same-named
    // candidate in test/shared.ts could match if it was the only `shared.ts`
    // around or even ambiguously when both existed.
    const symbols = [
      sym("src/features/a.ts", "caller"),
      sym("test/shared.ts", "shared"), // wrong-directory same-basename trap
    ];
    const edges: ParserEdge[] = [
      // hint says relative-up-one to "shared", from inside src/features/
      { from: "src/features/a.ts::caller", to_name: "shared", to_path: "../shared", kind: "imports" },
    ];
    const { edges: resolved, unresolved } = resolveEdges({ symbols, edges });
    // The resolver MUST NOT pick test/shared.ts — its directory doesn't
    // match the relative hint resolved from src/features/.
    expect(resolved[0]!.resolved).toBe(false);
    expect(unresolved).toContain("shared");
  });

  it("uses to_path resolved against fromPath dir to disambiguate (RED §07 #2)", () => {
    const symbols = [
      sym("src/features/a.ts", "caller"),
      sym("src/shared.ts", "shared"),
      sym("test/shared.ts", "shared"),
    ];
    const edges: ParserEdge[] = [
      { from: "src/features/a.ts::caller", to_name: "shared", to_path: "../shared", kind: "imports" },
    ];
    const { edges: resolved } = resolveEdges({ symbols, edges });
    // Should resolve to src/shared.ts (sibling-up dir of src/features/),
    // not test/shared.ts.
    expect(resolved[0]!.resolved).toBe(true);
    expect(resolved[0]!.to).toBe("src/shared.ts::shared");
  });

  it("matches a candidate whose path is the resolved hint with an extension or /index (RED §07 #2)", () => {
    const symbols = [
      sym("src/features/a.ts", "caller"),
      sym("src/shared.ts", "shared"),
    ];
    const edges: ParserEdge[] = [
      { from: "src/features/a.ts::caller", to_name: "shared", to_path: "../shared", kind: "imports" },
    ];
    const { edges: resolved } = resolveEdges({ symbols, edges });
    expect(resolved[0]!.to).toBe("src/shared.ts::shared");
  });

  it("returns sorted distinct unresolved names", () => {
    const symbols = [sym("a.ts", "x")];
    const edges: ParserEdge[] = [
      { from: "a.ts::x", to_name: "zzz", kind: "calls" },
      { from: "a.ts::x", to_name: "aaa", kind: "calls" },
      { from: "a.ts::x", to_name: "zzz", kind: "calls" },
    ];
    const { unresolved } = resolveEdges({ symbols, edges });
    expect(unresolved).toEqual(["aaa", "zzz"]);
  });
});

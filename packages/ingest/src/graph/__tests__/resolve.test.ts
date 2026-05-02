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

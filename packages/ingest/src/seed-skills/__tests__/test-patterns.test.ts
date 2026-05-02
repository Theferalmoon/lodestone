// SPDX-License-Identifier: Apache-2.0
// Codex v0.1.1 §11 RED #1 (scanner backlog): test-convention scanner.
import { describe, expect, it } from "vitest";

import { detectTestPatterns } from "../test-patterns.js";

import { mkClassParseResult, mkImportsParseResult } from "./fixtures.js";
import type { ParseResult } from "../../parsers/base.js";
import type { LodestoneSymbol } from "@lodestone/shared";

function fileWith(path: string, imports: readonly string[] = []): ParseResult {
  return mkImportsParseResult(path, imports);
}

function symbolOnly(path: string, language: LodestoneSymbol["language"] = "typescript"): ParseResult {
  return {
    symbols: [
      {
        symbol: `${path}::stub`,
        path,
        range: { start_line: 1, end_line: 1 },
        language,
        kind: "function",
      },
    ],
    edges: [],
    class_inheritance: [],
    warnings: [],
  };
}

describe("detectTestPatterns", () => {
  it("returns null when no test files exist", () => {
    expect(
      detectTestPatterns({
        parseResults: [
          symbolOnly("src/foo.ts"),
          symbolOnly("src/bar.ts"),
        ],
      }),
    ).toBeNull();
  });

  it("returns null when only one test file exists (sample size < 2)", () => {
    expect(
      detectTestPatterns({
        parseResults: [symbolOnly("src/foo.test.ts")],
      }),
    ).toBeNull();
  });

  it("emits a card when at least 2 *.test.ts files exist (vitest detected from imports)", () => {
    const result = detectTestPatterns({
      parseResults: [
        fileWith("src/a.test.ts", ["vitest"]),
        fileWith("src/b.test.ts", ["vitest"]),
        symbolOnly("src/a.ts"),
        symbolOnly("src/b.ts"),
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.slug).toBe("tests");
    expect(result!.evidence_count).toBe(2);
    expect(result!.body).toMatch(/vitest/i);
  });

  it("detects jest from imports", () => {
    const result = detectTestPatterns({
      parseResults: [
        fileWith("src/a.test.js", ["jest"]),
        fileWith("src/b.test.js", ["@jest/globals"]),
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.body).toMatch(/jest/i);
  });

  it("detects pytest from imports (.py)", () => {
    const result = detectTestPatterns({
      parseResults: [
        fileWith("tests/test_foo.py", ["pytest"]),
        fileWith("tests/test_bar.py", ["pytest"]),
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.body).toMatch(/pytest/i);
  });

  it("detects go test convention from *_test.go suffix even without imports", () => {
    const result = detectTestPatterns({
      parseResults: [
        symbolOnly("foo_test.go", "go"),
        symbolOnly("bar_test.go", "go"),
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.body).toMatch(/go test/i);
  });

  it("matches *.spec.ts in addition to *.test.ts", () => {
    const result = detectTestPatterns({
      parseResults: [
        fileWith("src/a.spec.ts", ["vitest"]),
        fileWith("src/b.spec.ts", ["vitest"]),
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.evidence_count).toBe(2);
  });

  it("falls back to a generic 'project test runner' label when ambiguous", () => {
    const result = detectTestPatterns({
      parseResults: [
        symbolOnly("src/a.test.ts"),
        symbolOnly("src/b.test.ts"),
      ],
    });
    expect(result).not.toBeNull();
    // No imports detected — generic label.
    expect(result!.body.toLowerCase()).toMatch(/test runner|test framework/);
  });

  it("produces a stable id for identical inputs", () => {
    const corpus = [
      fileWith("src/a.test.ts", ["vitest"]),
      fileWith("src/b.test.ts", ["vitest"]),
    ];
    const a = detectTestPatterns({ parseResults: corpus });
    const b = detectTestPatterns({ parseResults: corpus });
    expect(a!.id).toBe(b!.id);
    expect(a!.body).toBe(b!.body);
  });

  it("body contains evidence sample paths in `Where` section", () => {
    const result = detectTestPatterns({
      parseResults: [
        fileWith("src/a.test.ts", ["vitest"]),
        fileWith("src/b.test.ts", ["vitest"]),
        fileWith("src/c.test.ts", ["vitest"]),
      ],
    });
    expect(result!.body).toContain("## Where");
    expect(result!.body).toContain("src/a.test.ts");
  });

  it("uses the `framework-detector` slug-style namespace? returns slug 'tests'", () => {
    const result = detectTestPatterns({
      parseResults: [
        fileWith("src/a.test.ts", ["vitest"]),
        fileWith("src/b.test.ts", ["vitest"]),
      ],
    });
    expect(result!.slug).toBe("tests");
    expect(result!.name).toMatch(/test/i);
  });
});

// SPDX-License-Identifier: Apache-2.0
// Codex v0.1.1 §11 RED #1 (scanner backlog): logging-convention scanner.
import { describe, expect, it } from "vitest";

import { detectLoggingPatterns } from "../logging-patterns.js";

import { mkImportsParseResult } from "./fixtures.js";

describe("detectLoggingPatterns", () => {
  it("returns null on empty input", () => {
    expect(detectLoggingPatterns({ parseResults: [] })).toBeNull();
  });

  it("returns null when no logger-shaped imports exist", () => {
    expect(
      detectLoggingPatterns({
        parseResults: [mkImportsParseResult("src/a.ts", ["express", "fs", "path"])],
      }),
    ).toBeNull();
  });

  it("returns null when only one file imports a logger (sample size < 2)", () => {
    expect(
      detectLoggingPatterns({
        parseResults: [mkImportsParseResult("src/a.ts", ["winston"])],
      }),
    ).toBeNull();
  });

  it("emits a card for the dominant logger (winston >= 2 importers)", () => {
    const result = detectLoggingPatterns({
      parseResults: [
        mkImportsParseResult("src/a.ts", ["winston"]),
        mkImportsParseResult("src/b.ts", ["winston"]),
        mkImportsParseResult("src/c.ts", ["winston"]),
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.slug).toBe("logging");
    expect(result!.evidence_count).toBe(3);
    expect(result!.body).toMatch(/winston/i);
  });

  it("recognises pino", () => {
    const result = detectLoggingPatterns({
      parseResults: [
        mkImportsParseResult("src/a.ts", ["pino"]),
        mkImportsParseResult("src/b.ts", ["pino"]),
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.body).toMatch(/pino/i);
  });

  it("recognises Python logging stdlib (must be ≥2 importers)", () => {
    const result = detectLoggingPatterns({
      parseResults: [
        mkImportsParseResult("src/a.py", ["logging"]),
        mkImportsParseResult("src/b.py", ["logging"]),
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.body.toLowerCase()).toContain("logging");
  });

  it("recognises Go slog / logrus", () => {
    const result = detectLoggingPatterns({
      parseResults: [
        mkImportsParseResult("src/a.go", ["log/slog"]),
        mkImportsParseResult("src/b.go", ["log/slog"]),
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.body).toMatch(/slog/i);
  });

  it("recognises Rust tracing crate", () => {
    const result = detectLoggingPatterns({
      parseResults: [
        mkImportsParseResult("src/a.rs", ["tracing"]),
        mkImportsParseResult("src/b.rs", ["tracing"]),
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.body).toMatch(/tracing/i);
  });

  it("picks the dominant logger when multiple compete", () => {
    const result = detectLoggingPatterns({
      parseResults: [
        // 2 winston
        mkImportsParseResult("src/a.ts", ["winston"]),
        mkImportsParseResult("src/b.ts", ["winston"]),
        // 4 pino — should win
        mkImportsParseResult("src/c.ts", ["pino"]),
        mkImportsParseResult("src/d.ts", ["pino"]),
        mkImportsParseResult("src/e.ts", ["pino"]),
        mkImportsParseResult("src/f.ts", ["pino"]),
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.evidence_count).toBe(4);
    expect(result!.body).toMatch(/pino/i);
  });

  it("ignores non-logger imports (express, fs)", () => {
    expect(
      detectLoggingPatterns({
        parseResults: [
          mkImportsParseResult("src/a.ts", ["express", "fs"]),
          mkImportsParseResult("src/b.ts", ["express", "path"]),
        ],
      }),
    ).toBeNull();
  });

  it("counts distinct importing files, not duplicate imports in the same file", () => {
    const result = detectLoggingPatterns({
      parseResults: [
        mkImportsParseResult("src/a.ts", ["winston", "winston"]),
        mkImportsParseResult("src/b.ts", ["winston"]),
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.evidence_count).toBe(2);
  });

  it("produces a stable id for identical inputs", () => {
    const corpus = [
      mkImportsParseResult("src/a.ts", ["winston"]),
      mkImportsParseResult("src/b.ts", ["winston"]),
    ];
    const a = detectLoggingPatterns({ parseResults: corpus });
    const b = detectLoggingPatterns({ parseResults: corpus });
    expect(a!.id).toBe(b!.id);
    expect(a!.body).toBe(b!.body);
  });
});

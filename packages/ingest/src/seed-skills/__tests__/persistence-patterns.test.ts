// SPDX-License-Identifier: Apache-2.0
// Codex v0.1.1 §11 RED #1 (scanner backlog): persistence/transaction-wrapper
// scanner.
import { describe, expect, it } from "vitest";

import { detectPersistencePatterns } from "../persistence-patterns.js";

import { mkImportsParseResult } from "./fixtures.js";

describe("detectPersistencePatterns", () => {
  it("returns null on empty input", () => {
    expect(detectPersistencePatterns({ parseResults: [] })).toBeNull();
  });

  it("returns null when no persistence-shaped imports exist", () => {
    expect(
      detectPersistencePatterns({
        parseResults: [mkImportsParseResult("src/a.ts", ["fs", "path", "express"])],
      }),
    ).toBeNull();
  });

  it("returns null when only one file imports a persistence lib (sample size < 2)", () => {
    expect(
      detectPersistencePatterns({
        parseResults: [mkImportsParseResult("src/a.ts", ["@prisma/client"])],
      }),
    ).toBeNull();
  });

  it("emits a card for Prisma (≥2 importers)", () => {
    const result = detectPersistencePatterns({
      parseResults: [
        mkImportsParseResult("src/a.ts", ["@prisma/client"]),
        mkImportsParseResult("src/b.ts", ["@prisma/client"]),
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.slug).toBe("persistence");
    expect(result!.evidence_count).toBe(2);
    expect(result!.body.toLowerCase()).toContain("prisma");
  });

  it("recognises drizzle-orm", () => {
    const result = detectPersistencePatterns({
      parseResults: [
        mkImportsParseResult("src/a.ts", ["drizzle-orm"]),
        mkImportsParseResult("src/b.ts", ["drizzle-orm/pg-core"]),
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.body.toLowerCase()).toContain("drizzle");
  });

  it("recognises typeorm", () => {
    const result = detectPersistencePatterns({
      parseResults: [
        mkImportsParseResult("src/a.ts", ["typeorm"]),
        mkImportsParseResult("src/b.ts", ["typeorm"]),
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.body.toLowerCase()).toContain("typeorm");
  });

  it("recognises Python SQLAlchemy", () => {
    const result = detectPersistencePatterns({
      parseResults: [
        mkImportsParseResult("app/db/a.py", ["sqlalchemy"]),
        mkImportsParseResult("app/db/b.py", ["sqlalchemy.orm"]),
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.body.toLowerCase()).toContain("sqlalchemy");
  });

  it("recognises Go gorm", () => {
    const result = detectPersistencePatterns({
      parseResults: [
        mkImportsParseResult("internal/db/a.go", ["gorm.io/gorm"]),
        mkImportsParseResult("internal/db/b.go", ["gorm.io/gorm"]),
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.body.toLowerCase()).toContain("gorm");
  });

  it("recognises Rust diesel/sqlx", () => {
    const result = detectPersistencePatterns({
      parseResults: [
        mkImportsParseResult("src/a.rs", ["sqlx"]),
        mkImportsParseResult("src/b.rs", ["sqlx"]),
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.body.toLowerCase()).toContain("sqlx");
  });

  it("recognises better-sqlite3 / pg / mysql2", () => {
    const result = detectPersistencePatterns({
      parseResults: [
        mkImportsParseResult("src/a.ts", ["better-sqlite3"]),
        mkImportsParseResult("src/b.ts", ["better-sqlite3"]),
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.body.toLowerCase()).toContain("better-sqlite3");
  });

  it("picks the dominant ORM when multiple compete", () => {
    const result = detectPersistencePatterns({
      parseResults: [
        // 2 prisma
        mkImportsParseResult("src/a.ts", ["@prisma/client"]),
        mkImportsParseResult("src/b.ts", ["@prisma/client"]),
        // 4 drizzle — should win
        mkImportsParseResult("src/c.ts", ["drizzle-orm"]),
        mkImportsParseResult("src/d.ts", ["drizzle-orm"]),
        mkImportsParseResult("src/e.ts", ["drizzle-orm"]),
        mkImportsParseResult("src/f.ts", ["drizzle-orm"]),
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.evidence_count).toBe(4);
    expect(result!.body.toLowerCase()).toContain("drizzle");
  });

  it("counts distinct importing files, not duplicate imports per file", () => {
    const result = detectPersistencePatterns({
      parseResults: [
        mkImportsParseResult("src/a.ts", ["@prisma/client", "@prisma/client"]),
        mkImportsParseResult("src/b.ts", ["@prisma/client"]),
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.evidence_count).toBe(2);
  });

  it("produces a stable id for identical inputs", () => {
    const corpus = [
      mkImportsParseResult("src/a.ts", ["@prisma/client"]),
      mkImportsParseResult("src/b.ts", ["@prisma/client"]),
    ];
    const a = detectPersistencePatterns({ parseResults: corpus });
    const b = detectPersistencePatterns({ parseResults: corpus });
    expect(a!.id).toBe(b!.id);
    expect(a!.body).toBe(b!.body);
  });
});

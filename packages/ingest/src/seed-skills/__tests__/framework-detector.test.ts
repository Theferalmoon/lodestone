// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { detectFrameworks } from "../framework-detector.js";

import { mkImportsParseResult } from "./fixtures.js";

describe("detectFrameworks", () => {
  it("returns an empty list when no framework imports exist", () => {
    const out = detectFrameworks({
      parseResults: [
        mkImportsParseResult("src/util.ts", ["lodash", "node:fs"]),
        mkImportsParseResult("src/math.ts", ["mathjs"]),
      ],
    });
    expect(out).toEqual([]);
  });

  it("requires ≥2 distinct importing files (one importer is not a convention)", () => {
    const out = detectFrameworks({
      parseResults: [mkImportsParseResult("src/server.ts", ["express"])],
    });
    expect(out).toEqual([]);
  });

  it("detects express when ≥2 files import it", () => {
    const out = detectFrameworks({
      parseResults: [
        mkImportsParseResult("src/server.ts", ["express"]),
        mkImportsParseResult("src/router.ts", ["express"]),
        mkImportsParseResult("src/middleware.ts", ["express"]),
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.slug).toBe("framework-express");
    expect(out[0]!.evidence_count).toBe(3);
    expect(out[0]!.sample_paths).toContain("src/router.ts");
    expect(out[0]!.body).toContain("Express");
    expect(out[0]!.body).toContain("(req, res, next) => { ... }");
  });

  it("detects FastAPI via subpath imports (fastapi.responses → fastapi)", () => {
    const out = detectFrameworks({
      parseResults: [
        mkImportsParseResult("app/main.py", ["fastapi"]),
        mkImportsParseResult("app/routes.py", ["fastapi.responses"]),
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.slug).toBe("framework-fastapi");
    expect(out[0]!.evidence_count).toBe(2);
  });

  it("detects gin via go-style import path with a sub-package", () => {
    const out = detectFrameworks({
      parseResults: [
        mkImportsParseResult("cmd/api/main.go", ["github.com/gin-gonic/gin"]),
        mkImportsParseResult("internal/router/router.go", [
          "github.com/gin-gonic/gin/binding",
        ]),
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.slug).toBe("framework-gin");
  });

  it("returns multiple frameworks when both qualify, ordered by evidence_count desc", () => {
    const out = detectFrameworks({
      parseResults: [
        mkImportsParseResult("src/a.ts", ["express"]),
        mkImportsParseResult("src/b.ts", ["express"]),
        mkImportsParseResult("src/c.ts", ["express"]),
        mkImportsParseResult("src/d.ts", ["fastify"]),
        mkImportsParseResult("src/e.ts", ["fastify"]),
      ],
    });
    expect(out).toHaveLength(2);
    expect(out[0]!.slug).toBe("framework-express");
    expect(out[0]!.evidence_count).toBe(3);
    expect(out[1]!.slug).toBe("framework-fastify");
    expect(out[1]!.evidence_count).toBe(2);
  });

  it("strips quoted module specifiers", () => {
    const out = detectFrameworks({
      parseResults: [
        mkImportsParseResult("src/a.ts", [`"express"`]),
        mkImportsParseResult("src/b.ts", [`'express'`]),
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.slug).toBe("framework-express");
  });

  it("does not double-count the same importer with multiple imports of the same framework", () => {
    const out = detectFrameworks({
      parseResults: [
        mkImportsParseResult("src/server.ts", ["express", "express"]),
        mkImportsParseResult("src/router.ts", ["express"]),
      ],
    });
    expect(out).toHaveLength(1);
    // 2 distinct importers, not 3 raw edges.
    expect(out[0]!.evidence_count).toBe(2);
  });

  it("produces a stable id for the same inputs", () => {
    const corpus = [
      mkImportsParseResult("src/a.ts", ["express"]),
      mkImportsParseResult("src/b.ts", ["express"]),
    ];
    const a = detectFrameworks({ parseResults: corpus });
    const b = detectFrameworks({ parseResults: corpus });
    expect(a[0]!.id).toBe(b[0]!.id);
    expect(a[0]!.body).toBe(b[0]!.body);
  });
});

// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { detectErrorHierarchy } from "../error-hierarchy.js";

import { mkClassParseResult } from "./fixtures.js";

describe("detectErrorHierarchy", () => {
  it("returns null when no class extends a known error root", () => {
    const result = detectErrorHierarchy({
      parseResults: [
        mkClassParseResult([
          { id: "src/widget.ts::Widget", path: "src/widget.ts", base: "Component" },
          { id: "src/gadget.ts::Gadget", path: "src/gadget.ts", base: "Component" },
        ]),
      ],
    });
    expect(result).toBeNull();
  });

  it("returns null when only a single custom error class exists (sample size < 2)", () => {
    const result = detectErrorHierarchy({
      parseResults: [
        mkClassParseResult([
          { id: "src/errors.ts::OnlyError", path: "src/errors.ts", base: "Error" },
        ]),
      ],
    });
    expect(result).toBeNull();
  });

  it("emits a Skill record describing the dominant Error family", () => {
    const result = detectErrorHierarchy({
      parseResults: [
        mkClassParseResult([
          { id: "src/errors.ts::AppError", path: "src/errors.ts", base: "Error" },
          { id: "src/errors.ts::AuthError", path: "src/errors.ts", base: "Error" },
          { id: "src/errors.ts::NotFoundError", path: "src/errors.ts", base: "Error" },
        ]),
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.slug).toBe("errors");
    expect(result!.evidence_count).toBe(3);
    expect(result!.sample_paths).toContain("src/errors.ts");
    expect(result!.body).toContain("# Error / exception convention");
    expect(result!.body).toContain("`Error`");
    expect(result!.body).toContain("AppError");
  });

  it("groups by base root and picks the largest family", () => {
    const result = detectErrorHierarchy({
      parseResults: [
        mkClassParseResult([
          // 2 descendants of Error
          { id: "src/a.ts::AError", path: "src/a.ts", base: "Error" },
          { id: "src/b.ts::BError", path: "src/b.ts", base: "Error" },
          // 4 descendants of Exception (Python)
          { id: "src/x.py::XEx", path: "src/x.py", base: "Exception" },
          { id: "src/y.py::YEx", path: "src/y.py", base: "Exception" },
          { id: "src/z.py::ZEx", path: "src/z.py", base: "Exception" },
          { id: "src/q.py::QEx", path: "src/q.py", base: "Exception" },
        ]),
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.evidence_count).toBe(4);
    expect(result!.body).toContain("Exception");
  });

  it("treats a qualified base name (MyLib.Error) as the bare root (Error)", () => {
    const result = detectErrorHierarchy({
      parseResults: [
        mkClassParseResult([
          { id: "src/a.ts::A", path: "src/a.ts", base: "MyLib.Error" },
          { id: "src/b.ts::B", path: "src/b.ts", base: "OtherLib.Error" },
        ]),
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.evidence_count).toBe(2);
  });

  it("produces a stable id for the same inputs (idempotency-safe)", () => {
    const corpus = [
      mkClassParseResult([
        { id: "src/errors.ts::AppError", path: "src/errors.ts", base: "Error" },
        { id: "src/errors.ts::AuthError", path: "src/errors.ts", base: "Error" },
      ]),
    ];
    const a = detectErrorHierarchy({ parseResults: corpus });
    const b = detectErrorHierarchy({ parseResults: corpus });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.id).toBe(b!.id);
    expect(a!.body).toBe(b!.body);
  });

  it("returns null on empty input", () => {
    expect(detectErrorHierarchy({ parseResults: [] })).toBeNull();
  });

  it("recognises Python Exception family", () => {
    const result = detectErrorHierarchy({
      parseResults: [
        mkClassParseResult([
          {
            id: "app/errors.py::DomainError",
            path: "app/errors.py",
            base: "Exception",
            language: "python",
          },
          {
            id: "app/errors.py::OtherError",
            path: "app/errors.py",
            base: "Exception",
            language: "python",
          },
        ]),
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.evidence_count).toBe(2);
    expect(result!.sample_paths).toContain("app/errors.py");
  });
});

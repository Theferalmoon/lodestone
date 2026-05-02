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

  it("Codex v0.1.1 §11 RED #2 — climbs the inheritance chain to count transitive descendants", () => {
    // Real-world pattern: AppError extends Error, then NotFoundError +
    // ValidationError extend AppError. Only AppError's `base_name` is "Error";
    // the descendants don't reach a built-in root in one hop. Prior to the
    // fix, only AppError counted (1 member -> below threshold -> no card).
    const result = detectErrorHierarchy({
      parseResults: [
        mkClassParseResult([
          { id: "src/errors.ts::AppError", path: "src/errors.ts", base: "Error" },
          { id: "src/errors.ts::NotFoundError", path: "src/errors.ts", base: "AppError" },
          { id: "src/errors.ts::ValidationError", path: "src/errors.ts", base: "AppError" },
          { id: "src/errors.ts::AuthError", path: "src/errors.ts", base: "AppError" },
        ]),
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.evidence_count).toBe(4);
    expect(result!.body).toContain("AppError");
    expect(result!.body).toContain("NotFoundError");
  });

  it("Codex v0.1.1 §11 RED #2 — handles deep multi-level chains (root -> mid -> leaf -> leaf2)", () => {
    const result = detectErrorHierarchy({
      parseResults: [
        mkClassParseResult([
          { id: "src/errors.ts::AppError", path: "src/errors.ts", base: "Exception", language: "python" },
          { id: "src/errors.ts::DBError", path: "src/errors.ts", base: "AppError", language: "python" },
          { id: "src/errors.ts::TimeoutError", path: "src/errors.ts", base: "DBError", language: "python" },
          { id: "src/errors.ts::ConnectError", path: "src/errors.ts", base: "DBError", language: "python" },
          { id: "src/errors.ts::SlowError", path: "src/errors.ts", base: "TimeoutError", language: "python" },
        ]),
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.evidence_count).toBe(5);
  });

  it("Codex v0.1.1 §11 RED #3 — Rust impl Error for Type yields the implementing struct, not synthetic impl id", () => {
    // The Rust parser stores `impl Error for MyError` as a synthetic class
    // with id `impl_Error_for_MyError`. Prior to the fix, the seed scanner
    // surfaced that synthetic id verbatim ("MyError" was lost behind
    // "impl_Error_for_MyError"). The fix should detect the impl_<Trait>_for_<Type>
    // shape and use <Type> as the displayed class name.
    const result = detectErrorHierarchy({
      parseResults: [
        mkClassParseResult([
          {
            id: "src/errors.rs::impl_Error_for_MyError",
            path: "src/errors.rs",
            base: "Error",
            language: "rust",
          },
          {
            id: "src/errors.rs::impl_Error_for_NotFoundError",
            path: "src/errors.rs",
            base: "Error",
            language: "rust",
          },
        ]),
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.evidence_count).toBe(2);
    // The body must mention the real types, not the synthetic impl name.
    expect(result!.body).toContain("MyError");
    expect(result!.body).toContain("NotFoundError");
    expect(result!.body).not.toContain("impl_Error_for_");
  });

  it("Codex r2 §11 PARTIAL — qualified base name (errors.AppError) still chains transitively", () => {
    // AppError extends Error (bare); NotFoundError + ValidationError extend
    // `errors.AppError` (qualified). Pre-r2 the BFS queue searched for
    // `AppError` while the qualified-form children were indexed under
    // `errors.AppError`, so the chain broke and only AppError counted.
    const result = detectErrorHierarchy({
      parseResults: [
        mkClassParseResult([
          { id: "src/errors.ts::AppError", path: "src/errors.ts", base: "Error" },
          { id: "src/api.ts::NotFoundError", path: "src/api.ts", base: "errors.AppError" },
          { id: "src/api.ts::ValidationError", path: "src/api.ts", base: "errors.AppError" },
        ]),
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.evidence_count).toBe(3);
    expect(result!.body).toContain("AppError");
    expect(result!.body).toContain("NotFoundError");
    expect(result!.body).toContain("ValidationError");
  });

  it("Codex r2 §11 PARTIAL — Rust impl scoped trait (impl std::error::Error for MyErr) recovers implementing struct", () => {
    // The Rust parser builds the synthetic id literal
    // `impl_std::error::Error_for_MyErr`, which after qualifiedName join
    // becomes `src/e.rs::impl_std::error::Error_for_MyErr`. Pre-r2 the
    // last `::` segment was `Error_for_MyErr`, missing the `impl_` prefix
    // entirely → friendlyClassName returned the wrong literal. r2 walks
    // segments to find the `impl_`-prefixed one and rejoins.
    const result = detectErrorHierarchy({
      parseResults: [
        mkClassParseResult([
          {
            id: "src/e.rs::impl_std::error::Error_for_MyErr",
            path: "src/e.rs",
            base: "std::error::Error",
            language: "rust",
          },
          {
            id: "src/e.rs::impl_crate::Foo::Bar_for_Baz",
            path: "src/e.rs",
            base: "std::error::Error",
            language: "rust",
          },
        ]),
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.evidence_count).toBe(2);
    expect(result!.body).toContain("MyErr");
    expect(result!.body).toContain("Baz");
    expect(result!.body).not.toContain("Error_for_MyErr");
    expect(result!.body).not.toContain("Bar_for_Baz");
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

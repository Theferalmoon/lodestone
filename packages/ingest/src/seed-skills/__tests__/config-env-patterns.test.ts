// SPDX-License-Identifier: Apache-2.0
// Codex v0.1.1 §11 RED #1 (scanner backlog): config/env-convention scanner.
import { describe, expect, it } from "vitest";

import { detectConfigEnvPatterns } from "../config-env-patterns.js";

import { mkImportsParseResult } from "./fixtures.js";

describe("detectConfigEnvPatterns", () => {
  it("returns null on empty input", () => {
    expect(detectConfigEnvPatterns({ parseResults: [] })).toBeNull();
  });

  it("returns null when no config/env-shaped imports exist", () => {
    expect(
      detectConfigEnvPatterns({
        parseResults: [mkImportsParseResult("src/a.ts", ["fs", "path"])],
      }),
    ).toBeNull();
  });

  it("returns null when only one config-importing file exists (sample size < 2)", () => {
    expect(
      detectConfigEnvPatterns({
        parseResults: [mkImportsParseResult("src/a.ts", ["dotenv"])],
      }),
    ).toBeNull();
  });

  it("emits a card for dotenv (≥2 importers)", () => {
    const result = detectConfigEnvPatterns({
      parseResults: [
        mkImportsParseResult("src/a.ts", ["dotenv"]),
        mkImportsParseResult("src/b.ts", ["dotenv"]),
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.slug).toBe("config-env");
    expect(result!.evidence_count).toBe(2);
    expect(result!.body.toLowerCase()).toContain("dotenv");
  });

  it("recognises zod-based env schemas (envalid, t3-env, znv)", () => {
    const result = detectConfigEnvPatterns({
      parseResults: [
        mkImportsParseResult("src/env.ts", ["envalid"]),
        mkImportsParseResult("src/config.ts", ["envalid"]),
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.body.toLowerCase()).toContain("envalid");
  });

  it("recognises Python pydantic-settings + python-decouple", () => {
    const result = detectConfigEnvPatterns({
      parseResults: [
        mkImportsParseResult("app/settings.py", ["pydantic_settings"]),
        mkImportsParseResult("app/conf.py", ["pydantic_settings"]),
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.body.toLowerCase()).toContain("pydantic");
  });

  it("recognises Go viper", () => {
    const result = detectConfigEnvPatterns({
      parseResults: [
        mkImportsParseResult("cmd/main.go", ["github.com/spf13/viper"]),
        mkImportsParseResult("internal/config.go", ["github.com/spf13/viper"]),
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.body.toLowerCase()).toContain("viper");
  });

  it("recognises a project-local config module (config-style import path)", () => {
    const result = detectConfigEnvPatterns({
      parseResults: [
        mkImportsParseResult("src/a.ts", ["./config", "./util"]),
        mkImportsParseResult("src/b.ts", ["../config", "./util"]),
        mkImportsParseResult("src/c.ts", ["./config"]),
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.body.toLowerCase()).toContain("config");
  });

  it("picks the dominant convention when multiple candidates compete", () => {
    const result = detectConfigEnvPatterns({
      parseResults: [
        // 2 dotenv
        mkImportsParseResult("src/a.ts", ["dotenv"]),
        mkImportsParseResult("src/b.ts", ["dotenv"]),
        // 4 envalid — should win
        mkImportsParseResult("src/c.ts", ["envalid"]),
        mkImportsParseResult("src/d.ts", ["envalid"]),
        mkImportsParseResult("src/e.ts", ["envalid"]),
        mkImportsParseResult("src/f.ts", ["envalid"]),
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.evidence_count).toBe(4);
    expect(result!.body.toLowerCase()).toContain("envalid");
  });

  it("counts distinct importing files, not duplicate imports per file", () => {
    const result = detectConfigEnvPatterns({
      parseResults: [
        mkImportsParseResult("src/a.ts", ["dotenv", "dotenv"]),
        mkImportsParseResult("src/b.ts", ["dotenv"]),
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.evidence_count).toBe(2);
  });

  it("produces a stable id for identical inputs", () => {
    const corpus = [
      mkImportsParseResult("src/a.ts", ["dotenv"]),
      mkImportsParseResult("src/b.ts", ["dotenv"]),
    ];
    const a = detectConfigEnvPatterns({ parseResults: corpus });
    const b = detectConfigEnvPatterns({ parseResults: corpus });
    expect(a!.id).toBe(b!.id);
    expect(a!.body).toBe(b!.body);
  });

  it("ignores stdlib non-config imports (fs, path, os)", () => {
    expect(
      detectConfigEnvPatterns({
        parseResults: [
          mkImportsParseResult("src/a.ts", ["fs", "path", "os"]),
          mkImportsParseResult("src/b.ts", ["fs", "path"]),
        ],
      }),
    ).toBeNull();
  });
});

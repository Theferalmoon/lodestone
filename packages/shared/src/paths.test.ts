// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  canonicalLodestoneDir,
  lodestoneSubpath,
  LODESTONE_DIRNAME,
  type LodestoneSubpathKey,
} from "./paths.js";

describe("paths resolver", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "lodestone-paths-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("LODESTONE_DIRNAME is exactly '.lodestone'", () => {
    expect(LODESTONE_DIRNAME).toBe(".lodestone");
  });

  it("canonicalLodestoneDir returns <cwd>/.lodestone", () => {
    const dir = canonicalLodestoneDir(tmp);
    expect(dir).toBe(path.join(tmp, ".lodestone"));
  });

  it("canonicalLodestoneDir creates the parent (cwd) if missing", () => {
    const deep = path.join(tmp, "deep", "nested", "project");
    expect(existsSync(deep)).toBe(false);
    canonicalLodestoneDir(deep);
    expect(existsSync(deep)).toBe(true);
  });

  it("canonicalLodestoneDir does NOT create .lodestone itself (caller's responsibility)", () => {
    const dir = canonicalLodestoneDir(tmp);
    expect(existsSync(dir)).toBe(false);
  });

  it("lodestoneSubpath resolves all known keys", () => {
    const keys: LodestoneSubpathKey[] = [
      "lance",
      "sqlite",
      "models",
      "skills",
      "seedSkills",
      "emergingSkills",
      "archiveSkills",
      "runtime",
      "feedbackJsonl",
      "ready",
      "config",
      "installManifest",
    ];
    for (const k of keys) {
      const p = lodestoneSubpath(tmp, k);
      expect(p.startsWith(path.join(tmp, ".lodestone"))).toBe(true);
    }
  });

  it("lodestoneSubpath uses path.sep (cross-platform safe — not hardcoded /)", () => {
    const p = lodestoneSubpath(tmp, "lance");
    // The subpath must contain path.sep at the boundaries, not a literal "/"
    // (which would break on Windows). Asserting against `path.join` builds the
    // expected value the platform-native way.
    expect(p).toBe(path.join(tmp, ".lodestone", "lance"));
  });

  it("seedSkills key produces nested skills/seed (cross-platform-safe construction)", () => {
    const p = lodestoneSubpath(tmp, "seedSkills");
    expect(p).toBe(path.join(tmp, ".lodestone", "skills", "seed"));
  });

  it("rejects unknown subpath key (no string-blind traversal)", () => {
    expect(() => lodestoneSubpath(tmp, "../etc/passwd" as LodestoneSubpathKey)).toThrow(
      /Unknown lodestone subpath key/
    );
    expect(() => lodestoneSubpath(tmp, "models/../../escape" as LodestoneSubpathKey)).toThrow(
      /Unknown lodestone subpath key/
    );
  });
});

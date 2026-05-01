// SPDX-License-Identifier: Apache-2.0
// Bootstrap tests — verify the §01 monorepo scaffolding is intact.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("§01 monorepo bootstrap", () => {
  it("workspace declaration: pnpm-workspace.yaml exists with packages/* glob", () => {
    const wsPath = path.join(REPO_ROOT, "pnpm-workspace.yaml");
    expect(existsSync(wsPath)).toBe(true);
    const ws = parseYaml(readFileSync(wsPath, "utf8")) as { packages?: string[] };
    expect(Array.isArray(ws.packages)).toBe(true);
    expect(ws.packages).toContain("packages/*");
  });

  it("tsconfig.base.json is referenceable from any package depth", () => {
    const baseTsconfig = path.join(REPO_ROOT, "tsconfig.base.json");
    expect(existsSync(baseTsconfig)).toBe(true);

    // Create a temporary probe package, extend the base config, run tsc --noEmit.
    const probeDir = path.join(REPO_ROOT, "packages", "_probe");
    mkdirSync(probeDir, { recursive: true });
    const probeTsconfig = path.join(probeDir, "tsconfig.json");
    writeFileSync(
      probeTsconfig,
      JSON.stringify({ extends: "../../tsconfig.base.json", files: [] }, null, 2)
    );
    try {
      execFileSync(
        path.join(REPO_ROOT, "node_modules", ".bin", "tsc"),
        ["--noEmit", "-p", probeDir],
        { cwd: REPO_ROOT, stdio: "pipe" }
      );
    } finally {
      rmSync(probeDir, { recursive: true, force: true });
    }
  });

  it("LICENSE is canonical Apache-2.0 text", () => {
    const licensePath = path.join(REPO_ROOT, "LICENSE");
    expect(existsSync(licensePath)).toBe(true);
    const text = readFileSync(licensePath, "utf8");
    expect(text).toContain("Apache License");
    expect(text).toContain("Version 2.0, January 2004");
    expect(text).toContain("http://www.apache.org/licenses/");
  });

  it("LICENSE-AUTHORIZATION.md records rights-holder authorization (load-bearing legal doc)", () => {
    const authPath = path.join(REPO_ROOT, "LICENSE-AUTHORIZATION.md");
    expect(existsSync(authPath)).toBe(true);
    const text = readFileSync(authPath, "utf8");
    // Strong assertions — this file does legal load-bearing work per Codex 001.
    expect(text).toMatch(/authoriz/i);
    expect(text).toContain("Apache License, Version 2.0");
    expect(text).toContain("Theferalmoon"); // signature line
    expect(text).toContain("2026-05-01"); // date
    // Component list must be intact:
    for (const component of [
      "cmndi-flywheel",
      "cmndi-clusterer",
      "cmndi-skill-emitter",
      "cmndi-context-engine",
      "cmnd-embed-home",
    ]) {
      expect(text).toContain(component);
    }
    // Must NOT contain the unfilled placeholder
    expect(text).not.toMatch(/\[will be filled by .*?\]/);
  });

  it("NOTICE file documents extracted-component provenance", () => {
    const noticePath = path.join(REPO_ROOT, "NOTICE");
    expect(existsSync(noticePath)).toBe(true);
    const text = readFileSync(noticePath, "utf8");
    expect(text).toContain("LICENSE-AUTHORIZATION.md");
    expect(text).toContain("cmndi-flywheel");
  });

  it("root .gitignore includes the required entries plus secret hygiene", () => {
    const gi = readFileSync(path.join(REPO_ROOT, ".gitignore"), "utf8");
    for (const line of [
      "node_modules/",
      "dist/",
      "*.tsbuildinfo",
      ".lodestone/",
      "coverage/",
      ".DS_Store",
      "*.log",
      ".env",
    ]) {
      expect(gi).toContain(line);
    }
  });

  it("package.json declares pnpm packageManager + engines.node>=20 + private", () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
    expect(pkg.private).toBe(true);
    expect(pkg.packageManager).toMatch(/^pnpm@/);
    expect(pkg.engines?.node).toBeDefined();
    expect(String(pkg.engines.node)).toMatch(/2\d/);
  });

  it("pnpm -r build exits zero (real exec, not string-match)", () => {
    // Per spec acceptance criterion 3 + Codex review: actually run the build.
    // With zero workspace packages this is a no-op + exit 0.
    execFileSync("pnpm", ["-r", "build"], { cwd: REPO_ROOT, stdio: "pipe" });
  });

  it("pnpm audit reports zero high or critical findings", () => {
    // Spec test #5 — zero high/critical CVEs in installed deps.
    // Allow moderate findings to pass (per spec wording).
    execFileSync("pnpm", ["audit", "--audit-level=high", "--prod"], {
      cwd: REPO_ROOT,
      stdio: "pipe",
    });
  });
});

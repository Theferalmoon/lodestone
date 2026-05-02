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

  it("tsconfig.base.json is referenceable from any package depth (empty probe)", () => {
    const baseTsconfig = path.join(REPO_ROOT, "tsconfig.base.json");
    expect(existsSync(baseTsconfig)).toBe(true);

    // Empty probe: just verifies the base config is well-formed JSON and resolvable.
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

  it("tsconfig.base.json compiles a 2-file relative import with `.js` extension (NodeNext convention)", () => {
    // NodeNext requires explicit `.js` extensions on relative imports from TS source.
    // Lodestone authors TS source against this convention. This test proves it works
    // and serves as the executable spec for "how to write imports in this repo."
    const probeDir = path.join(REPO_ROOT, "packages", "_nodenext_probe");
    const srcDir = path.join(probeDir, "src");
    mkdirSync(srcDir, { recursive: true });

    writeFileSync(
      path.join(probeDir, "tsconfig.json"),
      JSON.stringify(
        {
          extends: "../../tsconfig.base.json",
          compilerOptions: { outDir: "dist", rootDir: "src" },
          include: ["src/**/*.ts"],
        },
        null,
        2
      )
    );
    writeFileSync(path.join(srcDir, "a.ts"), `export const value = 21;\n`);
    writeFileSync(
      path.join(srcDir, "b.ts"),
      `import { value } from "./a.js";\nexport const doubled = value * 2;\n`
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

  it("pnpm audit reports zero high or critical findings (excluding documented exceptions)", () => {
    // Spec test #5 — zero high/critical CVEs in installed deps EXCEPT the
    // pre-acknowledged ones documented in docs/KNOWN-ISSUES.md. The runtime
    // path for those is verified safe; we still want this test to catch
    // any NEW high/critical that lands.
    //
    // Allowlist format: GHSA id + short reason. Adding a new entry MUST be
    // accompanied by a docs/KNOWN-ISSUES.md write-up explaining why the
    // finding doesn't affect Lodestone's runtime path.
    const ALLOWED_ADVISORIES = new Set<string>([
      // protobufjs <7.5.5 prototype-pollution, only triggered by attacker-
      // controlled protobuf input; Lodestone loads its own pinned weights.
      "GHSA-xq3m-2v4x-88gg",
    ]);

    let auditJson: string;
    try {
      auditJson = execFileSync("pnpm", ["audit", "--audit-level=high", "--json"], {
        cwd: REPO_ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
      });
    } catch (err) {
      // pnpm audit exits non-zero when it finds anything at the requested
      // level; the JSON we want is on stdout regardless.
      const e = err as { stdout?: string | Buffer };
      auditJson = typeof e.stdout === "string" ? e.stdout : e.stdout?.toString() ?? "";
    }
    if (!auditJson.trim()) {
      // No findings → audit returned empty; treat as pass.
      return;
    }
    const report = JSON.parse(auditJson) as {
      advisories?: Record<string, { severity: string; github_advisory_id?: string; module_name?: string }>;
    };
    const offenders: string[] = [];
    for (const adv of Object.values(report.advisories ?? {})) {
      if (adv.severity !== "high" && adv.severity !== "critical") continue;
      const ghsa = adv.github_advisory_id ?? "";
      if (ALLOWED_ADVISORIES.has(ghsa)) continue;
      offenders.push(`${adv.severity} ${ghsa} (${adv.module_name ?? "?"})`);
    }
    expect(offenders).toEqual([]);
  });
});

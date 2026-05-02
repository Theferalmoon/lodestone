// SPDX-License-Identifier: Apache-2.0
// Codex v0.1.1 §11 RED #4: real `lodestone seed-skills` command coverage.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { seedSkills } from "../commands/seed-skills.js";

let workdir: string;
let prevCwd: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "lodestone-seed-cli-"));
  prevCwd = process.cwd();
  process.chdir(workdir);
});

afterEach(() => {
  process.chdir(prevCwd);
  rmSync(workdir, { recursive: true, force: true });
});

describe("`lodestone seed-skills` (Codex v0.1.1 §11 RED #4)", () => {
  it("exits non-zero with a clear error when .lodestone/ does not exist", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exit = await seedSkills([]);
    expect(exit).not.toBe(0);
    const printed = errSpy.mock.calls.flat().join("\n");
    expect(printed.toLowerCase()).toMatch(/lodestone init|\.lodestone/);
    errSpy.mockRestore();
  });

  it("scans the repo, runs all seed scanners, and writes seed SKILL.md files", async () => {
    // Build a tiny synthetic repo: create .lodestone/ marker dir + a couple
    // of TS files importing express + a custom Error hierarchy.
    mkdirSync(join(workdir, ".lodestone"), { recursive: true });
    mkdirSync(join(workdir, "src"), { recursive: true });
    writeFileSync(
      join(workdir, "src/server.ts"),
      `import express from "express";\nconst app = express();\n`,
      "utf8",
    );
    writeFileSync(
      join(workdir, "src/router.ts"),
      `import express from "express";\nimport { Router } from "express";\n`,
      "utf8",
    );
    writeFileSync(
      join(workdir, "src/errors.ts"),
      `export class AppError extends Error {}\nexport class NotFoundError extends AppError {}\nexport class ValidationError extends AppError {}\n`,
      "utf8",
    );

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exit = await seedSkills([]);
    logSpy.mockRestore();
    errSpy.mockRestore();

    expect(exit).toBe(0);
    // Express card emitted (≥2 importers).
    expect(existsSync(join(workdir, ".lodestone/skills/seed/framework-express/SKILL.md"))).toBe(true);
    // Errors card emitted (transitive AppError chain >=2).
    expect(existsSync(join(workdir, ".lodestone/skills/seed/errors/SKILL.md"))).toBe(true);
  });

  it("is idempotent — second run does not rewrite existing SKILL.md files", async () => {
    mkdirSync(join(workdir, ".lodestone"), { recursive: true });
    mkdirSync(join(workdir, "src"), { recursive: true });
    writeFileSync(
      join(workdir, "src/a.ts"),
      `import express from "express";\n`,
      "utf8",
    );
    writeFileSync(
      join(workdir, "src/b.ts"),
      `import express from "express";\n`,
      "utf8",
    );

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await seedSkills([])).toBe(0);
    const skillPath = join(workdir, ".lodestone/skills/seed/framework-express/SKILL.md");
    const firstText = readFileSync(skillPath, "utf8");
    expect(await seedSkills([])).toBe(0);
    const secondText = readFileSync(skillPath, "utf8");
    logSpy.mockRestore();
    errSpy.mockRestore();
    expect(secondText).toBe(firstText);
  });

  it("frontmatter source field is 'seed' on emitted cards", async () => {
    mkdirSync(join(workdir, ".lodestone"), { recursive: true });
    mkdirSync(join(workdir, "src"), { recursive: true });
    writeFileSync(
      join(workdir, "src/a.ts"),
      `import express from "express";\n`,
      "utf8",
    );
    writeFileSync(
      join(workdir, "src/b.ts"),
      `import express from "express";\n`,
      "utf8",
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await seedSkills([]);
    logSpy.mockRestore();
    errSpy.mockRestore();
    const text = readFileSync(
      join(workdir, ".lodestone/skills/seed/framework-express/SKILL.md"),
      "utf8",
    );
    expect(text).toMatch(/^---\n/);
    expect(text).toMatch(/source: seed\n/);
  });
});

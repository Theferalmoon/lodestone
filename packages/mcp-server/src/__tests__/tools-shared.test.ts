// SPDX-License-Identifier: Apache-2.0
// POST-§20 Issue B: tools/_shared.resolveDbPath() consolidates §14 + §15
// env-var resolution. Previously §14 honored `LODESTONE_CWD` and §15 honored
// `LODESTONE_DB_PATH` — both pointing at the same DB but reached via
// different paths. The §20 e2e harness had to set both env vars to keep the
// surfaces aligned. These tests pin the unified precedence chain so the
// regression can't recur.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _setTestDbPath, resolveDbPath, resolveCwd, resolveSqlitePath } from "../tools/_shared.js";

const ENV_KEYS = ["LODESTONE_DB_PATH", "LODESTONE_CWD"] as const;

let prev: Record<(typeof ENV_KEYS)[number], string | undefined>;
let cwdDir: string;
let altDir: string;

beforeEach(() => {
  prev = {
    LODESTONE_DB_PATH: process.env.LODESTONE_DB_PATH,
    LODESTONE_CWD: process.env.LODESTONE_CWD,
  };
  for (const k of ENV_KEYS) delete process.env[k];
  _setTestDbPath(null);
  // canonicalLodestoneDir under @lodestone/shared mkdir's the cwd to ensure
  // .lodestone exists — use real tmp dirs so the side-effect is benign.
  cwdDir = mkdtempSync(path.join(tmpdir(), "lodestone-shared-cwd-"));
  altDir = mkdtempSync(path.join(tmpdir(), "lodestone-shared-alt-"));
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = prev[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  _setTestDbPath(null);
  for (const dir of [cwdDir, altDir]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

describe("resolveDbPath precedence (POST-§20 Issue B)", () => {
  it("(1) test override wins over every env var", () => {
    process.env.LODESTONE_DB_PATH = path.join(cwdDir, "explicit-env-db.sqlite");
    process.env.LODESTONE_CWD = altDir;
    _setTestDbPath("/test/override/lodestone.sqlite");
    expect(resolveDbPath()).toBe("/test/override/lodestone.sqlite");
  });

  it("(2) LODESTONE_DB_PATH wins over LODESTONE_CWD when no override", () => {
    const dbPath = path.join(cwdDir, "explicit-env-db.sqlite");
    process.env.LODESTONE_DB_PATH = dbPath;
    process.env.LODESTONE_CWD = altDir;
    expect(resolveDbPath()).toBe(dbPath);
  });

  it("(3) LODESTONE_CWD derives the DB path when LODESTONE_DB_PATH is unset", () => {
    process.env.LODESTONE_CWD = cwdDir;
    expect(resolveDbPath()).toBe(path.join(cwdDir, ".lodestone", "lodestone.sqlite"));
  });

  it("(4) process.cwd() is the final fallback", () => {
    // Both env vars unset → resolveCwd() falls through to process.cwd().
    expect(resolveDbPath()).toBe(
      path.join(resolveCwd(), ".lodestone", "lodestone.sqlite"),
    );
  });

  it("ignores empty LODESTONE_DB_PATH and falls through to LODESTONE_CWD", () => {
    process.env.LODESTONE_DB_PATH = "";
    process.env.LODESTONE_CWD = cwdDir;
    expect(resolveDbPath()).toBe(path.join(cwdDir, ".lodestone", "lodestone.sqlite"));
  });

  it("resolveSqlitePath continues to honour an explicit cwd argument (back-compat)", () => {
    expect(resolveSqlitePath(cwdDir)).toBe(
      path.join(cwdDir, ".lodestone", "lodestone.sqlite"),
    );
  });
});

// SPDX-License-Identifier: Apache-2.0
// pause.shouldPause() tests — present, absent, no-.git, missing-root.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { shouldPause } from "../pause.js";

describe("shouldPause", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "lodestone-pause-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("returns true when .git/index.lock exists", async () => {
    await mkdir(path.join(tmp, ".git"), { recursive: true });
    await writeFile(path.join(tmp, ".git", "index.lock"), "");
    expect(await shouldPause(tmp)).toBe(true);
  });

  it("returns false when .git exists but index.lock does not", async () => {
    await mkdir(path.join(tmp, ".git"), { recursive: true });
    expect(await shouldPause(tmp)).toBe(false);
  });

  it("returns false when .git itself is absent (non-repo dir)", async () => {
    expect(await shouldPause(tmp)).toBe(false);
  });

  it("returns false when the repo root does not exist", async () => {
    const ghost = path.join(tmp, "does", "not", "exist");
    expect(await shouldPause(ghost)).toBe(false);
  });
});

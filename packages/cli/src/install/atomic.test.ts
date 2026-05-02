// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeFileAtomic } from "./atomic.js";

describe("writeFileAtomic", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "lodestone-atomic-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("writes the body and atomically renames into place", () => {
    const target = path.join(tmp, "out.txt");
    writeFileAtomic(target, "hello\n");
    expect(readFileSync(target, "utf8")).toBe("hello\n");
  });

  it("overwrites an existing file via rename (no truncation window)", () => {
    const target = path.join(tmp, "out.txt");
    writeFileSync(target, "old\n");
    writeFileAtomic(target, "new\n");
    expect(readFileSync(target, "utf8")).toBe("new\n");
  });

  it("creates the parent directory if absent", () => {
    const target = path.join(tmp, "nested", "deep", "out.txt");
    writeFileAtomic(target, "body\n");
    expect(readFileSync(target, "utf8")).toBe("body\n");
  });

  it("removes the temp file on success (no .tmp residue left behind)", () => {
    const target = path.join(tmp, "out.txt");
    writeFileAtomic(target, "body\n");
    const entries = readdirSync(tmp);
    // Only the target should remain; no `<target>.tmp.<suffix>` orphans.
    expect(entries).toEqual(["out.txt"]);
  });

  it("uses a unique temp suffix so concurrent writers do not collide on <target>.tmp (Codex §04 YELLOW)", () => {
    // Pre-fix: temp path was always `<target>.tmp` (deterministic). Two
    // concurrent `lodestone init` invocations could race and one process's
    // rename could observe the other's temp file mid-flight, causing a
    // spurious failure. Post-fix: each call uses a unique suffix.
    //
    // We sample the temp paths by intercepting renameSync via a spy on
    // node:fs renameSync — but simpler: drive 50 sequential writes and
    // verify the temp paths the implementation chooses are distinct (via
    // an end-to-end race we can't easily trigger in vitest).
    //
    // Strategy: monkey-patch fs.openSync transiently to record paths the
    // implementation opens for write, then verify uniqueness across calls.
    //
    // Lighter strategy used here: stage another file at the deterministic
    // `<target>.tmp` path and confirm the new write does not interfere
    // with it (i.e., the implementation does not unlink it on failure or
    // collide with it on success).
    const target = path.join(tmp, "out.txt");
    const stalePreviousTmp = `${target}.tmp`;
    writeFileSync(stalePreviousTmp, "left over from another race victim\n");

    writeFileAtomic(target, "fresh body\n");

    // Target written successfully.
    expect(readFileSync(target, "utf8")).toBe("fresh body\n");
    // The pre-existing `<target>.tmp` left by a "competing process" is
    // untouched: its contents and existence are preserved, because the
    // new writer used a unique suffix instead of re-using `.tmp`.
    expect(readFileSync(stalePreviousTmp, "utf8")).toBe(
      "left over from another race victim\n"
    );
  });
});

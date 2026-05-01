// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { updateGitignore } from "./gitignore.js";

describe("updateGitignore", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "lodestone-gitignore-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("creates .gitignore containing the line `.lodestone/` if absent", () => {
    const result = updateGitignore(tmp);
    expect(result.action).toBe("created");
    expect(result.path).toBe(path.join(tmp, ".gitignore"));
    const body = readFileSync(path.join(tmp, ".gitignore"), "utf8");
    expect(body).toMatch(/^\.lodestone\/$/m);
  });

  it("appends to existing .gitignore when line missing", () => {
    writeFileSync(path.join(tmp, ".gitignore"), "node_modules\n");
    const result = updateGitignore(tmp);
    expect(result.action).toBe("appended");
    const body = readFileSync(path.join(tmp, ".gitignore"), "utf8");
    expect(body).toMatch(/^node_modules$/m);
    expect(body).toMatch(/^\.lodestone\/$/m);
  });

  it("noop when line already present (with trailing newline)", () => {
    writeFileSync(path.join(tmp, ".gitignore"), "node_modules\n.lodestone/\n");
    const before = readFileSync(path.join(tmp, ".gitignore"));
    const result = updateGitignore(tmp);
    expect(result.action).toBe("noop");
    const after = readFileSync(path.join(tmp, ".gitignore"));
    expect(Buffer.compare(before, after)).toBe(0);
  });

  it("noop when line already present without trailing newline (last line, no \\n)", () => {
    writeFileSync(path.join(tmp, ".gitignore"), "node_modules\n.lodestone/");
    const before = readFileSync(path.join(tmp, ".gitignore"));
    const result = updateGitignore(tmp);
    expect(result.action).toBe("noop");
    const after = readFileSync(path.join(tmp, ".gitignore"));
    expect(Buffer.compare(before, after)).toBe(0);
  });

  it("does NOT match `lodestone/` (without leading dot) — appends `.lodestone/` instead", () => {
    writeFileSync(path.join(tmp, ".gitignore"), "lodestone/\n");
    const result = updateGitignore(tmp);
    expect(result.action).toBe("appended");
    const body = readFileSync(path.join(tmp, ".gitignore"), "utf8");
    // both lines present
    expect(body).toMatch(/^lodestone\/$/m);
    expect(body).toMatch(/^\.lodestone\/$/m);
  });

  it("does NOT match a comment line `# .lodestone/` (anchored exact match)", () => {
    writeFileSync(path.join(tmp, ".gitignore"), "# .lodestone/\n");
    const result = updateGitignore(tmp);
    expect(result.action).toBe("appended");
    const body = readFileSync(path.join(tmp, ".gitignore"), "utf8");
    expect(body).toMatch(/^\.lodestone\/$/m);
  });

  it("appended write ends with newline", () => {
    writeFileSync(path.join(tmp, ".gitignore"), "node_modules");
    updateGitignore(tmp);
    const body = readFileSync(path.join(tmp, ".gitignore"), "utf8");
    expect(body.endsWith("\n")).toBe(true);
  });

  it("idempotent — second call after a created/appended is a noop with byte-equal file", () => {
    updateGitignore(tmp); // created
    const after1 = readFileSync(path.join(tmp, ".gitignore"));
    const result = updateGitignore(tmp);
    expect(result.action).toBe("noop");
    const after2 = readFileSync(path.join(tmp, ".gitignore"));
    expect(Buffer.compare(after1, after2)).toBe(0);
  });

  it("written file exists at <repoRoot>/.gitignore", () => {
    expect(existsSync(path.join(tmp, ".gitignore"))).toBe(false);
    updateGitignore(tmp);
    expect(existsSync(path.join(tmp, ".gitignore"))).toBe(true);
  });

  it("CRLF input: line `.lodestone/\\r\\n` is recognized as already-present (no duplicate append)", () => {
    writeFileSync(path.join(tmp, ".gitignore"), "node_modules\r\n.lodestone/\r\n");
    const before = readFileSync(path.join(tmp, ".gitignore"));
    const result = updateGitignore(tmp);
    expect(result.action).toBe("noop");
    const after = readFileSync(path.join(tmp, ".gitignore"));
    expect(Buffer.compare(before, after)).toBe(0);
  });
});

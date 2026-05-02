// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { augmentClaudeMd } from "../../install/claude-md.js";
import { removeClaudeMdBlock } from "../../uninstall/claude-md-uninstall.js";

describe("removeClaudeMdBlock", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "lodestone-claude-uninst-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("manifest claude_md = null → noop (conservative mode)", () => {
    writeFileSync(path.join(tmp, "CLAUDE.md"), "# friend\n<!-- BEGIN LODESTONE -->\nx\n<!-- END LODESTONE -->\n");
    const r = removeClaudeMdBlock(tmp, null);
    expect(r.action).toBe("noop");
    expect(existsSync(path.join(tmp, "CLAUDE.md"))).toBe(true);
  });

  it("manifest action = already_present → respected-provenance, file untouched", () => {
    const body = "# friend\n<!-- BEGIN LODESTONE -->\nfriend block\n<!-- END LODESTONE -->\n";
    writeFileSync(path.join(tmp, "CLAUDE.md"), body);
    const r = removeClaudeMdBlock(tmp, { action: "already_present", path: path.join(tmp, "CLAUDE.md") });
    expect(r.action).toBe("respected-provenance");
    expect(readFileSync(path.join(tmp, "CLAUDE.md"), "utf8")).toBe(body);
  });

  it("manifest action = skipped → respected-provenance", () => {
    const r = removeClaudeMdBlock(tmp, { action: "skipped" });
    expect(r.action).toBe("respected-provenance");
  });

  it("manifest action = created, file present → file deleted (removed-file)", () => {
    augmentClaudeMd({ write: true, repoRoot: tmp });
    expect(existsSync(path.join(tmp, "CLAUDE.md"))).toBe(true);
    const r = removeClaudeMdBlock(tmp, { action: "created", path: path.join(tmp, "CLAUDE.md") });
    expect(r.action).toBe("removed-file");
    expect(existsSync(path.join(tmp, "CLAUDE.md"))).toBe(false);
  });

  it("manifest action = created, file already gone → noop", () => {
    const r = removeClaudeMdBlock(tmp, { action: "created", path: path.join(tmp, "CLAUDE.md") });
    expect(r.action).toBe("noop");
  });

  it("appended (body ended with newline): excises block, restores friend body byte-identically", () => {
    const friendBody = "# My project\n\nIntro paragraph.\n";
    writeFileSync(path.join(tmp, "CLAUDE.md"), friendBody);
    augmentClaudeMd({ write: true, repoRoot: tmp });
    const r = removeClaudeMdBlock(tmp, { action: "appended", path: path.join(tmp, "CLAUDE.md") });
    expect(r.action).toBe("removed-block");
    expect(readFileSync(path.join(tmp, "CLAUDE.md"), "utf8")).toBe(friendBody);
  });

  it("appended (body did NOT end with newline): excises block, restores body + POSIX trailing nl", () => {
    // Documented policy: the post-install file has 2 consecutive newlines
    // before BEGIN regardless of whether the friend's body ended with "\n".
    // Uninstall normalizes to a single trailing newline (POSIX text-file
    // convention) when restoring — the friend's editor would re-add one
    // anyway on next save. Trades exact byte-identity for a no-surprise
    // outcome.
    const friendBody = "# My project\n\nIntro paragraph.";
    writeFileSync(path.join(tmp, "CLAUDE.md"), friendBody);
    augmentClaudeMd({ write: true, repoRoot: tmp });
    const r = removeClaudeMdBlock(tmp, { action: "appended", path: path.join(tmp, "CLAUDE.md") });
    expect(r.action).toBe("removed-block");
    expect(readFileSync(path.join(tmp, "CLAUDE.md"), "utf8")).toBe(`${friendBody}\n`);
  });

  it("appended onto an empty CLAUDE.md → file deleted (removed-file)", () => {
    writeFileSync(path.join(tmp, "CLAUDE.md"), "");
    augmentClaudeMd({ write: true, repoRoot: tmp });
    const r = removeClaudeMdBlock(tmp, { action: "appended", path: path.join(tmp, "CLAUDE.md") });
    expect(r.action).toBe("removed-file");
    expect(existsSync(path.join(tmp, "CLAUDE.md"))).toBe(false);
  });

  it("appended action but block already hand-removed → noop", () => {
    writeFileSync(path.join(tmp, "CLAUDE.md"), "# friend only\n");
    const r = removeClaudeMdBlock(tmp, { action: "appended", path: path.join(tmp, "CLAUDE.md") });
    expect(r.action).toBe("noop");
  });

  it("appended action but file gone → noop", () => {
    const r = removeClaudeMdBlock(tmp, { action: "appended", path: path.join(tmp, "CLAUDE.md") });
    expect(r.action).toBe("noop");
  });

  it("dryRun: removed-block reported, file untouched", () => {
    const friendBody = "# project\n";
    writeFileSync(path.join(tmp, "CLAUDE.md"), friendBody);
    augmentClaudeMd({ write: true, repoRoot: tmp });
    const before = readFileSync(path.join(tmp, "CLAUDE.md"));
    const r = removeClaudeMdBlock(
      tmp,
      { action: "appended", path: path.join(tmp, "CLAUDE.md") },
      { dryRun: true }
    );
    expect(r.action).toBe("removed-block");
    expect(Buffer.compare(before, readFileSync(path.join(tmp, "CLAUDE.md")))).toBe(0);
  });

  it("dryRun for created action: removed-file reported, file untouched", () => {
    augmentClaudeMd({ write: true, repoRoot: tmp });
    const before = readFileSync(path.join(tmp, "CLAUDE.md"));
    const r = removeClaudeMdBlock(
      tmp,
      { action: "created", path: path.join(tmp, "CLAUDE.md") },
      { dryRun: true }
    );
    expect(r.action).toBe("removed-file");
    expect(Buffer.compare(before, readFileSync(path.join(tmp, "CLAUDE.md")))).toBe(0);
  });
});

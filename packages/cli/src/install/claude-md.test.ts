// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { augmentClaudeMd, BEGIN_MARKER, END_MARKER } from "./claude-md.js";

describe("augmentClaudeMd", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "lodestone-claudemd-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("write=false → action 'skipped' and does not touch any file", () => {
    const result = augmentClaudeMd({ write: false, repoRoot: tmp });
    expect(result.action).toBe("skipped");
    expect(existsSync(path.join(tmp, "CLAUDE.md"))).toBe(false);
  });

  it("write=true on empty repo creates CLAUDE.md with marker-bracketed snippet", () => {
    const result = augmentClaudeMd({ write: true, repoRoot: tmp });
    expect(result.action).toBe("created");
    expect(result.path).toBe(path.join(tmp, "CLAUDE.md"));
    const body = readFileSync(path.join(tmp, "CLAUDE.md"), "utf8");
    expect(body).toContain(BEGIN_MARKER);
    expect(body).toContain(END_MARKER);
    expect(body).toMatch(/Lodestone/);
  });

  it("write=true on existing CLAUDE.md without markers appends the stanza, preserves prior content", () => {
    writeFileSync(path.join(tmp, "CLAUDE.md"), "# Project rules\n\nAlways run tests.\n");
    const result = augmentClaudeMd({ write: true, repoRoot: tmp });
    expect(result.action).toBe("appended");
    const body = readFileSync(path.join(tmp, "CLAUDE.md"), "utf8");
    expect(body.startsWith("# Project rules\n\nAlways run tests.\n")).toBe(true);
    expect(body).toContain(BEGIN_MARKER);
    expect(body).toContain(END_MARKER);
  });

  it("idempotent — write=true twice produces byte-identical files", () => {
    augmentClaudeMd({ write: true, repoRoot: tmp });
    const after1 = readFileSync(path.join(tmp, "CLAUDE.md"));
    const result = augmentClaudeMd({ write: true, repoRoot: tmp });
    expect(result.action).toBe("already_present");
    const after2 = readFileSync(path.join(tmp, "CLAUDE.md"));
    expect(Buffer.compare(after1, after2)).toBe(0);
  });

  it("preserves friend's hand-edits between markers (markers present ⇒ already_present, no rewrite)", () => {
    augmentClaudeMd({ write: true, repoRoot: tmp });
    const original = readFileSync(path.join(tmp, "CLAUDE.md"), "utf8");
    // Edit the contents between the markers
    const edited = original.replace(
      /BEGIN LODESTONE -->[\s\S]*?<!-- END LODESTONE/,
      "BEGIN LODESTONE -->\n\nFRIEND'S CUSTOM CONTENT\n\n<!-- END LODESTONE"
    );
    expect(edited).not.toBe(original);
    writeFileSync(path.join(tmp, "CLAUDE.md"), edited);

    const result = augmentClaudeMd({ write: true, repoRoot: tmp });
    expect(result.action).toBe("already_present");
    const after = readFileSync(path.join(tmp, "CLAUDE.md"), "utf8");
    expect(after).toBe(edited);
    expect(after).toContain("FRIEND'S CUSTOM CONTENT");
  });

  it("re-appends if the friend deleted the marker stanza (idempotency keyed on marker presence, not content hash)", () => {
    augmentClaudeMd({ write: true, repoRoot: tmp });
    // Friend strips the lodestone markers entirely
    writeFileSync(path.join(tmp, "CLAUDE.md"), "# Project rules\n\nNo lodestone here, please.\n");
    const result = augmentClaudeMd({ write: true, repoRoot: tmp });
    expect(result.action).toBe("appended");
    const body = readFileSync(path.join(tmp, "CLAUDE.md"), "utf8");
    expect(body).toContain(BEGIN_MARKER);
    expect(body).toContain(END_MARKER);
    expect(body).toContain("No lodestone here, please.");
  });
});

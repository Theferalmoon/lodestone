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
import { removeGitignoreLine } from "../../uninstall/gitignore-uninstall.js";

describe("removeGitignoreLine", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "lodestone-gi-uninst-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("manifest gitignore = null → noop (conservative mode)", () => {
    writeFileSync(path.join(tmp, ".gitignore"), ".lodestone/\n");
    const r = removeGitignoreLine(tmp, null);
    expect(r.action).toBe("noop");
    expect(existsSync(path.join(tmp, ".gitignore"))).toBe(true);
  });

  it("manifest action = noop → respected-provenance, file untouched", () => {
    const before = "node_modules/\n.lodestone/\n";
    writeFileSync(path.join(tmp, ".gitignore"), before);
    const r = removeGitignoreLine(tmp, { action: "noop", path: path.join(tmp, ".gitignore") });
    expect(r.action).toBe("respected-provenance");
    expect(readFileSync(path.join(tmp, ".gitignore"), "utf8")).toBe(before);
  });

  it("manifest action = created, file present → removed-file", () => {
    writeFileSync(path.join(tmp, ".gitignore"), ".lodestone/\n");
    const r = removeGitignoreLine(tmp, { action: "created", path: path.join(tmp, ".gitignore") });
    expect(r.action).toBe("removed-file");
    expect(existsSync(path.join(tmp, ".gitignore"))).toBe(false);
  });

  it("manifest action = created but file gone → noop", () => {
    const r = removeGitignoreLine(tmp, { action: "created", path: path.join(tmp, ".gitignore") });
    expect(r.action).toBe("noop");
  });

  it("appended: removes only the .lodestone/ line, preserves friend body", () => {
    writeFileSync(path.join(tmp, ".gitignore"), "node_modules/\n.env\n.lodestone/\n");
    const r = removeGitignoreLine(tmp, { action: "appended", path: path.join(tmp, ".gitignore") });
    expect(r.action).toBe("removed-line");
    expect(readFileSync(path.join(tmp, ".gitignore"), "utf8")).toBe(
      "node_modules/\n.env\n"
    );
  });

  it("CRLF-tolerant: removes a `.lodestone/\\r\\n` line in a CRLF-formatted file", () => {
    writeFileSync(path.join(tmp, ".gitignore"), "node_modules/\r\n.lodestone/\r\n");
    const r = removeGitignoreLine(tmp, { action: "appended", path: path.join(tmp, ".gitignore") });
    expect(r.action).toBe("removed-line");
    // Remaining line keeps its CR; trailing newline preserved by split/join.
    expect(readFileSync(path.join(tmp, ".gitignore"), "utf8")).toBe(
      "node_modules/\r\n"
    );
  });

  it("does NOT remove a commented `# .lodestone/` line", () => {
    const body = "# .lodestone/\nnode_modules/\n.lodestone/\n";
    writeFileSync(path.join(tmp, ".gitignore"), body);
    const r = removeGitignoreLine(tmp, { action: "appended", path: path.join(tmp, ".gitignore") });
    expect(r.action).toBe("removed-line");
    expect(readFileSync(path.join(tmp, ".gitignore"), "utf8")).toBe(
      "# .lodestone/\nnode_modules/\n"
    );
  });

  it("does NOT remove `lodestone/` (no leading dot)", () => {
    const body = "lodestone/\n";
    writeFileSync(path.join(tmp, ".gitignore"), body);
    const r = removeGitignoreLine(tmp, { action: "appended", path: path.join(tmp, ".gitignore") });
    expect(r.action).toBe("noop");
    expect(readFileSync(path.join(tmp, ".gitignore"), "utf8")).toBe(body);
  });

  it("appended onto a file that originally had only newlines → file deleted when result empty", () => {
    writeFileSync(path.join(tmp, ".gitignore"), ".lodestone/\n");
    const r = removeGitignoreLine(tmp, { action: "appended", path: path.join(tmp, ".gitignore") });
    expect(r.action).toBe("removed-file");
    expect(existsSync(path.join(tmp, ".gitignore"))).toBe(false);
  });

  it("idempotent: appended action with line already absent → noop", () => {
    writeFileSync(path.join(tmp, ".gitignore"), "node_modules/\n");
    const r = removeGitignoreLine(tmp, { action: "appended", path: path.join(tmp, ".gitignore") });
    expect(r.action).toBe("noop");
  });

  it("appended action, file absent → noop", () => {
    const r = removeGitignoreLine(tmp, { action: "appended", path: path.join(tmp, ".gitignore") });
    expect(r.action).toBe("noop");
  });

  it("dryRun: removed-line reported, file untouched", () => {
    const before = "node_modules/\n.lodestone/\n";
    writeFileSync(path.join(tmp, ".gitignore"), before);
    const r = removeGitignoreLine(
      tmp,
      { action: "appended", path: path.join(tmp, ".gitignore") },
      { dryRun: true }
    );
    expect(r.action).toBe("removed-line");
    expect(readFileSync(path.join(tmp, ".gitignore"), "utf8")).toBe(before);
  });

  it("dryRun for created action: removed-file reported, file untouched", () => {
    writeFileSync(path.join(tmp, ".gitignore"), ".lodestone/\n");
    const before = readFileSync(path.join(tmp, ".gitignore"));
    const r = removeGitignoreLine(
      tmp,
      { action: "created", path: path.join(tmp, ".gitignore") },
      { dryRun: true }
    );
    expect(r.action).toBe("removed-file");
    expect(Buffer.compare(before, readFileSync(path.join(tmp, ".gitignore")))).toBe(0);
  });
});

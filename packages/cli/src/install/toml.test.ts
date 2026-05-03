// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";

import { writeLodestoneToml } from "./toml.js";

describe("writeLodestoneToml", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "lodestone-toml-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("creates .lodestone/lodestone.toml with project.name = repo basename", () => {
    const result = writeLodestoneToml(tmp);
    expect(result.action).toBe("created");
    const expected = path.join(tmp, ".lodestone", "lodestone.toml");
    expect(result.path).toBe(expected);
    expect(existsSync(expected)).toBe(true);
    const parsed = parseToml(readFileSync(expected, "utf8")) as {
      project?: { name?: string };
    };
    expect(parsed.project?.name).toBe(path.basename(tmp));
  });

  it("preserves an existing toml — does not overwrite operator edits", () => {
    mkdirSync(path.join(tmp, ".lodestone"), { recursive: true });
    const existing = '[project]\nname = "operator-edited"\n[ingest]\nbatch_size = 99\n';
    writeFileSync(path.join(tmp, ".lodestone", "lodestone.toml"), existing);
    const result = writeLodestoneToml(tmp);
    expect(result.action).toBe("preserved");
    const body = readFileSync(result.path, "utf8");
    expect(body).toBe(existing);
  });

  it("escapes quotes and backslashes in the project name", () => {
    // Synthetic case — would only matter if cwd contained unusual chars.
    // Tested by writing into a synthetic basename via direct call shape.
    // Easiest end-to-end: rename the tmp dir's last segment.
    const oddTmp = mkdtempSync(path.join(tmpdir(), 'lodestone-toml-with"quote-'));
    try {
      const result = writeLodestoneToml(oddTmp);
      const body = readFileSync(result.path, "utf8");
      // The quote in the basename must be escaped; toml must still parse.
      expect(body).toContain('\\"');
      const parsed = parseToml(body) as { project?: { name?: string } };
      expect(parsed.project?.name).toBe(path.basename(oddTmp));
    } finally {
      rmSync(oddTmp, { recursive: true, force: true });
    }
  });
});

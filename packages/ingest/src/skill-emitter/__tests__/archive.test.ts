// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expireOld } from "../archive.js";
import { renderFrontmatter, type FrontmatterFields } from "../frontmatter.js";

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "lodestone-archive-test-"));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function makeSkillFile(opts: {
  source: "seed" | "emerging" | "observed";
  slug: string;
  emittedAt: string;
  body?: string;
}): string {
  const dir = join(workdir, ".lodestone", "skills", opts.source, opts.slug);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  const fm: FrontmatterFields = {
    id: `id-${opts.slug}`,
    slug: opts.slug,
    name: opts.slug,
    description: "test",
    source: opts.source,
    emitted_at: opts.emittedAt,
    content_sha256: "x".repeat(64),
    member_count: 1,
    top_symbols: ["src/x.ts::y"],
    confidence: 0.5,
    observed_days: 0,
    evidence_count: 1,
  };
  const body = opts.body ?? "# body\n\nhello\n";
  writeFileSync(file, `${renderFrontmatter(fm)}${body}`, "utf8");
  return file;
}

describe("expireOld", () => {
  it("moves SKILL.md older than 60 days to .archive/<slug>", async () => {
    const oldFile = makeSkillFile({
      source: "emerging",
      slug: "old-skill",
      emittedAt: "2026-01-01T00:00:00Z",
    });
    const lodestoneDir = join(workdir, ".lodestone");
    const result = await expireOld({ lodestoneDir }, new Date("2026-05-01T00:00:00Z"));

    expect(result.movedCount).toBe(1);
    expect(existsSync(oldFile)).toBe(false);
    const archived = join(lodestoneDir, "skills", ".archive", "old-skill", "SKILL.md");
    expect(existsSync(archived)).toBe(true);
  });

  it("does NOT delete — source content == destination content after move", async () => {
    const body = "# distinctive body 7c4b1e\n\nhello\n";
    const oldFile = makeSkillFile({
      source: "emerging",
      slug: "intact-skill",
      emittedAt: "2026-01-01T00:00:00Z",
      body,
    });
    const before = readFileSync(oldFile, "utf8");
    const lodestoneDir = join(workdir, ".lodestone");
    await expireOld({ lodestoneDir }, new Date("2026-05-01T00:00:00Z"));
    const after = readFileSync(
      join(lodestoneDir, "skills", ".archive", "intact-skill", "SKILL.md"),
      "utf8",
    );
    expect(after).toBe(before);
    expect(after).toContain("distinctive body 7c4b1e");
  });

  it("leaves recent SKILL.md in place", async () => {
    const fresh = makeSkillFile({
      source: "emerging",
      slug: "fresh-skill",
      emittedAt: "2026-04-25T00:00:00Z",
    });
    const lodestoneDir = join(workdir, ".lodestone");
    const result = await expireOld({ lodestoneDir }, new Date("2026-05-01T00:00:00Z"));
    expect(result.movedCount).toBe(0);
    expect(existsSync(fresh)).toBe(true);
  });

  it("appends a numeric suffix on archive collision", async () => {
    // First archive lands at .archive/dup/.
    makeSkillFile({
      source: "emerging",
      slug: "dup",
      emittedAt: "2026-01-01T00:00:00Z",
    });
    const lodestoneDir = join(workdir, ".lodestone");
    await expireOld({ lodestoneDir }, new Date("2026-05-01T00:00:00Z"));

    // Re-create then re-archive: should land at .archive/dup-2/.
    makeSkillFile({
      source: "emerging",
      slug: "dup",
      emittedAt: "2026-01-15T00:00:00Z",
    });
    const result = await expireOld({ lodestoneDir }, new Date("2026-05-01T00:00:00Z"));
    expect(result.movedCount).toBe(1);
    expect(existsSync(join(lodestoneDir, "skills", ".archive", "dup-2", "SKILL.md"))).toBe(true);
  });

  it("skips files with malformed frontmatter (records in `skipped`)", async () => {
    const dir = join(workdir, ".lodestone", "skills", "emerging", "broken");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "SKILL.md");
    writeFileSync(file, "this is not valid frontmatter at all\n", "utf8");
    const lodestoneDir = join(workdir, ".lodestone");
    const result = await expireOld({ lodestoneDir }, new Date("2026-05-01T00:00:00Z"));
    expect(result.movedCount).toBe(0);
    expect(result.skipped.length).toBe(1);
  });

  it("returns empty result when the skills directory is missing", async () => {
    const result = await expireOld(
      { lodestoneDir: join(workdir, ".lodestone-doesnt-exist") },
      new Date("2026-05-01T00:00:00Z"),
    );
    expect(result).toEqual({ movedCount: 0, movedPaths: [], skipped: [] });
  });

  it("honors a custom expireDays", async () => {
    const file = makeSkillFile({
      source: "emerging",
      slug: "two-week-old",
      emittedAt: "2026-04-15T00:00:00Z",
    });
    const lodestoneDir = join(workdir, ".lodestone");
    const result = await expireOld(
      { lodestoneDir, expireDays: 10 },
      new Date("2026-05-01T00:00:00Z"),
    );
    expect(result.movedCount).toBe(1);
    expect(existsSync(file)).toBe(false);
  });
});

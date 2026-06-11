// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { main } from "../main.js";
import { VERSION, COMMIT_HASH, resolveCommitHash } from "../version.js";

describe("--version / -v", () => {
  it("prints version + commit hash to stdout", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await main(["--version"]);
    expect(code).toBe(0);
    const printed = log.mock.calls.flat().join("\n");
    expect(printed).toContain(VERSION);
    expect(printed).toContain(COMMIT_HASH);
    log.mockRestore();
  });

  it("`-v` is accepted as a synonym", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await main(["-v"]);
    expect(code).toBe(0);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("VERSION is non-empty and from this package's package.json", () => {
    expect(VERSION).not.toBe("");
    expect(VERSION).not.toBe("0.0.0-unknown");
  });

  it("COMMIT_HASH is a non-empty string (git short hash, build-injected, or 'dev')", () => {
    expect(typeof COMMIT_HASH).toBe("string");
    expect(COMMIT_HASH.length).toBeGreaterThan(0);
  });

  it("LODESTONE_COMMIT_HASH env injection wins over git and packaged metadata", () => {
    expect(
      resolveCommitHash({
        env: { LODESTONE_COMMIT_HASH: "env1234" },
        readGitCommitHash: () => "git1234",
        readPackagedBuildInfoCommit: () => "pkg1234",
      })
    ).toBe("env1234");
  });

  it("git metadata wins over packaged metadata inside a source checkout", () => {
    expect(
      resolveCommitHash({
        here: path.join("home", "theferalmoon", "lodestone", "packages", "cli", "dist"),
        env: {},
        readGitCommitHash: () => "git1234",
        readPackagedBuildInfoCommit: () => "pkg1234",
      })
    ).toBe("git1234");
  });

  it("packaged metadata wins over a host repo git hash inside node_modules", () => {
    expect(
      resolveCommitHash({
        here: path.join(tmpdir(), "friend-repo", "node_modules", "@lodestone", "cli", "dist"),
        env: {},
        readGitCommitHash: () => "hostgit",
        readPackagedBuildInfoCommit: () => "pkg1234",
      })
    ).toBe("pkg1234");
  });

  it("does not treat node_modules substrings as packaged installs", () => {
    expect(
      resolveCommitHash({
        here: path.join(tmpdir(), "node_modules_backup", "lodestone", "packages", "cli", "dist"),
        env: {},
        readGitCommitHash: () => "git1234",
        readPackagedBuildInfoCommit: () => "pkg1234",
      })
    ).toBe("git1234");
  });

  it("uses packaged build-info.json when git metadata is unavailable", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "lodestone-build-info-"));
    try {
      writeFileSync(
        path.join(tmp, "build-info.json"),
        `${JSON.stringify({ commit_hash: "pkg1234" }, null, 2)}\n`
      );
      expect(
        resolveCommitHash({
          here: tmp,
          env: {},
          readGitCommitHash: () => null,
        })
      ).toBe("pkg1234");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("falls back to dev when no env, git, or packaged metadata exists", () => {
    expect(
      resolveCommitHash({
        env: {},
        readGitCommitHash: () => null,
        readPackagedBuildInfoCommit: () => null,
      })
    ).toBe("dev");
  });
});

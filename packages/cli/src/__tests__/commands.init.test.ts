// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  init,
  parseInitArgv,
  runInstallSteps,
  type InstallManifest,
} from "../commands/init.js";

describe("parseInitArgv", () => {
  it("default flags are all false", () => {
    expect(parseInitArgv([])).toEqual({
      writeClaudeMd: false,
      pro: false,
      dryRun: false,
      noReindex: false,
    });
  });
  it("--write-claude-md", () => {
    expect(parseInitArgv(["--write-claude-md"])).toEqual({
      writeClaudeMd: true,
      pro: false,
      dryRun: false,
      noReindex: false,
    });
  });
  it("--pro", () => {
    expect(parseInitArgv(["--pro"])).toEqual({
      writeClaudeMd: false,
      pro: true,
      dryRun: false,
      noReindex: false,
    });
  });
  it("--dry-run", () => {
    expect(parseInitArgv(["--dry-run"])).toEqual({
      writeClaudeMd: false,
      pro: false,
      dryRun: true,
      noReindex: false,
    });
  });
  it("--no-reindex (POST-§20 Issue C)", () => {
    expect(parseInitArgv(["--no-reindex"])).toEqual({
      writeClaudeMd: false,
      pro: false,
      dryRun: false,
      noReindex: true,
    });
  });
  it("all flags together", () => {
    expect(parseInitArgv(["--write-claude-md", "--pro", "--dry-run", "--no-reindex"])).toEqual({
      writeClaudeMd: true,
      pro: true,
      dryRun: true,
      noReindex: true,
    });
  });
});

describe("runInstallSteps", () => {
  let tmp: string;
  let log: ReturnType<typeof vi.spyOn>;
  let err: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "lodestone-init-"));
    log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    err = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    log.mockRestore();
    err.mockRestore();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("on a clean repo: writes .mcp.json, .gitignore, prints CLAUDE.md snippet, writes manifest", () => {
    const manifest = runInstallSteps(tmp, { writeClaudeMd: false });

    expect(manifest.schema_version).toBe(1);
    expect(manifest.mcp_json.action).toBe("created");
    expect(manifest.gitignore.action).toBe("created");
    expect(manifest.claude_md.action).toBe("skipped");

    expect(existsSync(path.join(tmp, ".mcp.json"))).toBe(true);
    expect(existsSync(path.join(tmp, ".gitignore"))).toBe(true);
    expect(existsSync(path.join(tmp, "CLAUDE.md"))).toBe(false);
    expect(existsSync(path.join(tmp, ".lodestone", "install-manifest.json"))).toBe(true);

    // ISO-8601 timestamp.
    expect(manifest.installed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("write=true augments CLAUDE.md", () => {
    const manifest = runInstallSteps(tmp, { writeClaudeMd: true });
    expect(manifest.claude_md.action).toBe("created");
    expect(existsSync(path.join(tmp, "CLAUDE.md"))).toBe(true);
  });

  it("idempotent — re-running on the same repo only updates installed_at", () => {
    const first = runInstallSteps(tmp, { writeClaudeMd: true });
    const mcpAfter1 = readFileSync(path.join(tmp, ".mcp.json"));
    const giAfter1 = readFileSync(path.join(tmp, ".gitignore"));
    const cmAfter1 = readFileSync(path.join(tmp, "CLAUDE.md"));

    // sleep 1ms-ish via tiny await to ensure installed_at differs reliably.
    const t = Date.now();
    while (Date.now() === t) {
      /* spin briefly */
    }

    const second = runInstallSteps(tmp, { writeClaudeMd: true });
    expect(second.mcp_json.action).toBe("updated");
    expect(second.gitignore.action).toBe("noop");
    expect(second.claude_md.action).toBe("already_present");

    // Friend-facing files byte-equal across runs.
    expect(Buffer.compare(mcpAfter1, readFileSync(path.join(tmp, ".mcp.json")))).toBe(0);
    expect(Buffer.compare(giAfter1, readFileSync(path.join(tmp, ".gitignore")))).toBe(0);
    expect(Buffer.compare(cmAfter1, readFileSync(path.join(tmp, "CLAUDE.md")))).toBe(0);

    // Manifest.installed_at refreshed.
    expect(second.installed_at).not.toBe(first.installed_at);
  });

  it("manifest is well-formed JSON readable as InstallManifest", () => {
    runInstallSteps(tmp, { writeClaudeMd: false });
    const manifestPath = path.join(tmp, ".lodestone", "install-manifest.json");
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as InstallManifest;
    expect(parsed.schema_version).toBe(1);
    expect(parsed.mcp_json).toBeDefined();
    expect(parsed.gitignore).toBeDefined();
    expect(parsed.claude_md).toBeDefined();
  });
});

describe("init() handler", () => {
  let tmp: string;
  let prevCwd: string;
  let log: ReturnType<typeof vi.spyOn>;
  let err: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "lodestone-init-handler-"));
    prevCwd = process.cwd();
    process.chdir(tmp);
    log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    err = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    process.chdir(prevCwd);
    log.mockRestore();
    err.mockRestore();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns 0 on success and writes the expected files", async () => {
    expect(await init(["--no-reindex"])).toBe(0);
    expect(existsSync(path.join(tmp, ".mcp.json"))).toBe(true);
    expect(existsSync(path.join(tmp, ".gitignore"))).toBe(true);
    expect(existsSync(path.join(tmp, ".lodestone", "install-manifest.json"))).toBe(true);
  });

  it("--dry-run does not touch the filesystem", async () => {
    expect(await init(["--dry-run"])).toBe(0);
    expect(existsSync(path.join(tmp, ".mcp.json"))).toBe(false);
    expect(existsSync(path.join(tmp, ".gitignore"))).toBe(false);
    expect(existsSync(path.join(tmp, ".lodestone"))).toBe(false);
  });

  it("--pro warns (not yet implemented) but still completes successfully", async () => {
    expect(await init(["--pro", "--no-reindex"])).toBe(0);
    const stderr = err.mock.calls.flat().join("\n");
    expect(stderr).toMatch(/--pro/);
  });

  it("--write-claude-md augments CLAUDE.md", async () => {
    expect(await init(["--write-claude-md", "--no-reindex"])).toBe(0);
    expect(existsSync(path.join(tmp, "CLAUDE.md"))).toBe(true);
    const body = readFileSync(path.join(tmp, "CLAUDE.md"), "utf8");
    expect(body).toContain("BEGIN LODESTONE");
  });

  it("on second --write-claude-md run, prints a refresh hint (RED #5: stale-snippet visibility)", async () => {
    await init(["--write-claude-md", "--no-reindex"]); // first run — created
    log.mockClear();
    await init(["--write-claude-md", "--no-reindex"]); // second run — already_present
    const stdout = log.mock.calls.flat().join("\n");
    expect(stdout).toMatch(/already_present/);
    // Friend-facing refresh instructions must mention how to re-apply.
    expect(stdout).toMatch(/BEGIN.*END LODESTONE/i);
    expect(stdout).toMatch(/--write-claude-md/);
  });

  it("--no-reindex (POST-§20 Issue C): skips ingest, prints reindex hint", async () => {
    expect(await init(["--no-reindex"])).toBe(0);
    const stdout = log.mock.calls.flat().join("\n");
    expect(stdout).toMatch(/Skipping ingest/);
    expect(stdout).toMatch(/lodestone reindex/);
    // No ready.json should exist when ingest is skipped.
    expect(existsSync(path.join(tmp, ".lodestone", "ready.json"))).toBe(false);
  });
});

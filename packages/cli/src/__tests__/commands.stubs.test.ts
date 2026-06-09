// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { reindex } from "../commands/reindex.js";
import { doctor, parseDoctorArgv } from "../commands/doctor.js";
import { runInstallSteps } from "../commands/init.js";
import { upgrade } from "../commands/upgrade.js";
// init() is no longer a stub — it does real install work in §04.
// See commands.init.test.ts for its dedicated coverage.
// uninstall() is no longer a stub — it does real reversal work in §19.
// See commands.uninstall.test.ts for its dedicated coverage.
// doctor() is no longer a stub — it reports install + client adapter state.
// reindex() is no longer a stub — it runs the full ingest pipeline
// (POST-§20 Issue C). See commands.reindex.test.ts for dedicated coverage.
// seed-skills() is no longer a stub — Codex v0.1.1 §11 RED #4 fix.
// See commands.seed-skills.test.ts for its dedicated coverage.

describe("stub commands (return 0, warn, accept future flags)", () => {
  it("parseDoctorArgv() accepts optional client checks", () => {
    expect(parseDoctorArgv([])).toEqual({ clients: [] });
    expect(parseDoctorArgv(["--client", "codex"])).toEqual({
      clients: ["codex"],
    });
    expect(parseDoctorArgv(["--client=codex"])).toEqual({
      clients: ["codex"],
    });
    expect(parseDoctorArgv(["--client", "all"])).toEqual({
      clients: ["codex"],
    });
    expect(parseDoctorArgv(["--client="]).clientError).toMatch(
      /requires a value/
    );
    expect(parseDoctorArgv(["--client", "cursor"]).clientError).toMatch(
      /Unknown client/
    );
  });

  it("reindex() --dry-run returns 0 without touching the filesystem", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await reindex(["--dry-run"])).toBe(0);
    err.mockRestore();
    log.mockRestore();
  });

  it("doctor() returns 0 and reports baseline install state", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "lodestone-doctor-"));
    const prevCwd = process.cwd();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      process.chdir(tmp);
      expect(await doctor([])).toBe(0);
      const printed = log.mock.calls.flat().join("\n");
      expect(printed.toLowerCase()).toContain("doctor");
      expect(printed.toLowerCase()).toContain("install manifest");
    } finally {
      process.chdir(prevCwd);
      log.mockRestore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("doctor() returns 1 when install manifest records failed reindex", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "lodestone-doctor-"));
    const prevCwd = process.cwd();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      process.chdir(tmp);
      mkdirSync(path.join(tmp, ".lodestone"), { recursive: true });
      writeFileSync(
        path.join(tmp, ".lodestone", "install-manifest.json"),
        JSON.stringify({
          schema_version: 2,
          installed_at: new Date().toISOString(),
          install_state: "complete",
          reindex_state: "failed",
          mcp_json: { action: "created", path: path.join(tmp, ".mcp.json") },
          claude_md: { action: "skipped" },
          gitignore: { action: "created", path: path.join(tmp, ".gitignore") },
        })
      );
      expect(await doctor([])).toBe(1);
      expect(log.mock.calls.flat().join("\n")).toContain("reindex state");
      expect(err.mock.calls.flat().join("\n")).toContain("not fully healthy");
    } finally {
      process.chdir(prevCwd);
      log.mockRestore();
      err.mockRestore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("doctor() returns 1 when install manifest is unreadable or corrupt", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "lodestone-doctor-"));
    const prevCwd = process.cwd();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      process.chdir(tmp);
      mkdirSync(path.join(tmp, ".lodestone"), { recursive: true });
      writeFileSync(path.join(tmp, ".lodestone", "install-manifest.json"), "{not-json");
      expect(await doctor([])).toBe(1);
      const printed = log.mock.calls.flat().join("\n");
      expect(printed).toContain("invalid-json");
      expect(printed).toContain("manifest detail");
    } finally {
      process.chdir(prevCwd);
      log.mockRestore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("doctor() --client codex returns 1 when Codex config is missing", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "lodestone-doctor-"));
    const prevCwd = process.cwd();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      process.chdir(tmp);
      expect(await doctor(["--client", "codex"])).toBe(1);
      expect(log.mock.calls.flat().join("\n")).toContain("codex config");
      expect(err.mock.calls.flat().join("\n")).toContain("not healthy");
    } finally {
      process.chdir(prevCwd);
      log.mockRestore();
      err.mockRestore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("doctor() --client codex returns 0 when init wrote the Codex adapter", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "lodestone-doctor-"));
    const prevCwd = process.cwd();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      process.chdir(tmp);
      runInstallSteps(tmp, { writeClaudeMd: false, clients: ["codex"] });
      expect(await doctor(["--client", "codex"])).toBe(0);
      expect(log.mock.calls.flat().join("\n")).toContain("codex config");
      expect(log.mock.calls.flat().join("\n")).toContain("ok");
    } finally {
      process.chdir(prevCwd);
      log.mockRestore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("doctor() returns 1 when manifest says Codex config exists but it is stale", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "lodestone-doctor-"));
    const prevCwd = process.cwd();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      process.chdir(tmp);
      runInstallSteps(tmp, { writeClaudeMd: false, clients: ["codex"] });
      writeFileSync(
        path.join(tmp, ".codex", "config.toml"),
        '[mcp_servers.lodestone-mcp]\ncommand = "/old/path"\nargs = []\n'
      );
      expect(await doctor([])).toBe(1);
      expect(log.mock.calls.flat().join("\n")).toContain("stale");
      expect(err.mock.calls.flat().join("\n")).toContain("not healthy");
    } finally {
      process.chdir(prevCwd);
      log.mockRestore();
      err.mockRestore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("doctor() --client codex returns 1 and leaves malformed TOML untouched", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "lodestone-doctor-"));
    const prevCwd = process.cwd();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      process.chdir(tmp);
      mkdirSync(path.join(tmp, ".codex"), { recursive: true });
      writeFileSync(path.join(tmp, ".codex", "config.toml"), "[mcp_servers");
      expect(await doctor(["--client", "codex"])).toBe(1);
      expect(log.mock.calls.flat().join("\n")).toContain("unparseable");
      expect(err.mock.calls.flat().join("\n")).toContain("not healthy");
    } finally {
      process.chdir(prevCwd);
      log.mockRestore();
      err.mockRestore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("doctor() unknown --client exits as a usage error", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await doctor(["--client", "cursor"])).toBe(2);
      expect(err.mock.calls.flat().join("\n")).toContain("Unknown client");
    } finally {
      err.mockRestore();
    }
  });

  it("upgrade stub returns 0", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await upgrade([])).toBe(0);
    err.mockRestore();
  });

});

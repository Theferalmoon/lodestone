// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInstallSteps } from "../commands/init.js";
import { uninstall, parseUninstallArgv } from "../commands/uninstall.js";

describe("parseUninstallArgv", () => {
  it("default flags are all false", () => {
    expect(parseUninstallArgv([])).toEqual({ dryRun: false, keepIndex: false });
  });
  it("--dry-run", () => {
    expect(parseUninstallArgv(["--dry-run"])).toEqual({
      dryRun: true,
      keepIndex: false,
    });
  });
  it("--keep-index", () => {
    expect(parseUninstallArgv(["--keep-index"])).toEqual({
      dryRun: false,
      keepIndex: true,
    });
  });
  it("both flags together", () => {
    expect(parseUninstallArgv(["--dry-run", "--keep-index"])).toEqual({
      dryRun: true,
      keepIndex: true,
    });
  });
});

describe("uninstall() handler — end-to-end against real init output", () => {
  let tmp: string;
  let prevCwd: string;
  let log: ReturnType<typeof vi.spyOn>;
  let err: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "lodestone-uninstall-"));
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

  it("init → uninstall on a clean repo: removes everything init wrote, exits 0", async () => {
    runInstallSteps(tmp, { writeClaudeMd: true });
    expect(existsSync(path.join(tmp, ".lodestone"))).toBe(true);
    expect(existsSync(path.join(tmp, ".mcp.json"))).toBe(true);
    expect(existsSync(path.join(tmp, ".gitignore"))).toBe(true);
    expect(existsSync(path.join(tmp, "CLAUDE.md"))).toBe(true);

    expect(await uninstall([])).toBe(0);

    // .lodestone/ tree gone.
    expect(existsSync(path.join(tmp, ".lodestone"))).toBe(false);
    // .gitignore was created by init → fully removed.
    expect(existsSync(path.join(tmp, ".gitignore"))).toBe(false);
    // CLAUDE.md was created by init → fully removed.
    expect(existsSync(path.join(tmp, "CLAUDE.md"))).toBe(false);
    // .mcp.json kept (preserves friend's file structure even when empty).
    expect(existsSync(path.join(tmp, ".mcp.json"))).toBe(true);
    const mcp = JSON.parse(readFileSync(path.join(tmp, ".mcp.json"), "utf8"));
    expect(mcp).toEqual({ mcpServers: {} });
  });

  it("preserves a friend-authored .gitignore with .lodestone/ pre-existing", async () => {
    const friendBody = "node_modules/\n.lodestone/\n.env\n";
    writeFileSync(path.join(tmp, ".gitignore"), friendBody);

    runInstallSteps(tmp, { writeClaudeMd: false });
    expect(await uninstall([])).toBe(0);

    expect(existsSync(path.join(tmp, ".gitignore"))).toBe(true);
    expect(readFileSync(path.join(tmp, ".gitignore"), "utf8")).toBe(friendBody);
  });

  it("removes only the appended line from a friend-authored .gitignore", async () => {
    const friendBody = "node_modules/\n.env\n";
    writeFileSync(path.join(tmp, ".gitignore"), friendBody);

    runInstallSteps(tmp, { writeClaudeMd: false });
    expect(await uninstall([])).toBe(0);

    expect(readFileSync(path.join(tmp, ".gitignore"), "utf8")).toBe(friendBody);
  });

  it("respects friend-authored CLAUDE.md markers (already_present provenance)", async () => {
    const friendBody =
      "# My project\n\n<!-- BEGIN LODESTONE -->\nfriend wrote this\n<!-- END LODESTONE -->\n\nMore friend content.\n";
    writeFileSync(path.join(tmp, "CLAUDE.md"), friendBody);

    runInstallSteps(tmp, { writeClaudeMd: true });
    expect(await uninstall([])).toBe(0);

    // File untouched — manifest recorded `already_present`.
    expect(readFileSync(path.join(tmp, "CLAUDE.md"), "utf8")).toBe(friendBody);
  });

  it("removes only the appended block from a friend-authored CLAUDE.md", async () => {
    const friendBody = "# My project\n\nIntro paragraph.\n";
    writeFileSync(path.join(tmp, "CLAUDE.md"), friendBody);

    runInstallSteps(tmp, { writeClaudeMd: true });
    // Sanity: install added the block.
    expect(readFileSync(path.join(tmp, "CLAUDE.md"), "utf8")).toContain(
      "<!-- BEGIN LODESTONE -->"
    );

    expect(await uninstall([])).toBe(0);
    // Friend body restored byte-identical.
    expect(readFileSync(path.join(tmp, "CLAUDE.md"), "utf8")).toBe(friendBody);
  });

  it("preserves other .mcp.json server entries, leaves an empty {} when only ours was present", async () => {
    const otherEntry = {
      mcpServers: {
        "other-server": {
          command: "/usr/bin/other",
          args: ["--flag"],
          env: { FOO: "bar" },
        },
      },
    };
    writeFileSync(
      path.join(tmp, ".mcp.json"),
      `${JSON.stringify(otherEntry, null, 2)}\n`
    );

    runInstallSteps(tmp, { writeClaudeMd: false });
    expect(await uninstall([])).toBe(0);

    const after = JSON.parse(readFileSync(path.join(tmp, ".mcp.json"), "utf8"));
    expect(after).toEqual(otherEntry);
  });

  it("--dry-run mutates nothing on disk", async () => {
    runInstallSteps(tmp, { writeClaudeMd: true });
    const mcpBefore = readFileSync(path.join(tmp, ".mcp.json"));
    const giBefore = readFileSync(path.join(tmp, ".gitignore"));
    const cmBefore = readFileSync(path.join(tmp, "CLAUDE.md"));
    const manifestBefore = readFileSync(
      path.join(tmp, ".lodestone", "install-manifest.json")
    );

    expect(await uninstall(["--dry-run"])).toBe(0);

    // All four files byte-identical.
    expect(Buffer.compare(mcpBefore, readFileSync(path.join(tmp, ".mcp.json")))).toBe(0);
    expect(Buffer.compare(giBefore, readFileSync(path.join(tmp, ".gitignore")))).toBe(0);
    expect(Buffer.compare(cmBefore, readFileSync(path.join(tmp, "CLAUDE.md")))).toBe(0);
    expect(
      Buffer.compare(
        manifestBefore,
        readFileSync(path.join(tmp, ".lodestone", "install-manifest.json"))
      )
    ).toBe(0);
    expect(existsSync(path.join(tmp, ".lodestone"))).toBe(true);

    // Stdout described what WOULD happen.
    const stdout = log.mock.calls.flat().join("\n");
    expect(stdout).toMatch(/dry-run/i);
  });

  it("--keep-index removes agent integration but preserves .lodestone/ tree", async () => {
    runInstallSteps(tmp, { writeClaudeMd: false });
    expect(await uninstall(["--keep-index"])).toBe(0);

    // Agent integration gone.
    expect(existsSync(path.join(tmp, ".gitignore"))).toBe(false);
    const mcp = JSON.parse(readFileSync(path.join(tmp, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers["lodestone-mcp"]).toBeUndefined();
    // Data preserved.
    expect(existsSync(path.join(tmp, ".lodestone"))).toBe(true);
    expect(existsSync(path.join(tmp, ".lodestone", "install-manifest.json"))).toBe(true);
  });

  it("idempotent — second run on already-clean repo returns 0 with 'nothing to do' message", async () => {
    runInstallSteps(tmp, { writeClaudeMd: true });
    expect(await uninstall([])).toBe(0);
    log.mockClear();
    err.mockClear();

    expect(await uninstall([])).toBe(0);
    const stdout = log.mock.calls.flat().join("\n");
    expect(stdout.toLowerCase()).toContain("nothing to do");
  });

  it("conservative mode: missing manifest → only .mcp.json and .lodestone/ touched", async () => {
    // Simulate a repo in which init was never run but a friend left over a
    // .mcp.json with a lodestone-mcp entry (e.g., they cloned a pre-installed
    // repo without running lodestone init themselves).
    const friendGitignore = ".lodestone/\n";
    writeFileSync(path.join(tmp, ".gitignore"), friendGitignore);
    const friendClaude =
      "# My project\n\n<!-- BEGIN LODESTONE -->\nfriend\n<!-- END LODESTONE -->\n";
    writeFileSync(path.join(tmp, "CLAUDE.md"), friendClaude);
    writeFileSync(
      path.join(tmp, ".mcp.json"),
      `${JSON.stringify({ mcpServers: { "lodestone-mcp": { command: "x", args: [], env: {} } } }, null, 2)}\n`
    );

    expect(await uninstall([])).toBe(0);

    // .gitignore + CLAUDE.md left alone (no manifest = conservative mode).
    expect(readFileSync(path.join(tmp, ".gitignore"), "utf8")).toBe(friendGitignore);
    expect(readFileSync(path.join(tmp, "CLAUDE.md"), "utf8")).toBe(friendClaude);
    // .mcp.json entry removed (always attempted regardless of manifest).
    const mcp = JSON.parse(readFileSync(path.join(tmp, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers["lodestone-mcp"]).toBeUndefined();
    // Stderr mentions conservative mode.
    const stderr = err.mock.calls.flat().join("\n");
    expect(stderr.toLowerCase()).toMatch(/conservative mode/);
  });

  it("invalid-json manifest triggers conservative mode + warning, returns 0", async () => {
    runInstallSteps(tmp, { writeClaudeMd: false });
    // Corrupt the manifest.
    writeFileSync(
      path.join(tmp, ".lodestone", "install-manifest.json"),
      "{not json"
    );

    expect(await uninstall([])).toBe(0);
    const stderr = err.mock.calls.flat().join("\n");
    expect(stderr.toLowerCase()).toMatch(/conservative mode/);
    // .mcp.json + .lodestone/ still cleaned.
    expect(existsSync(path.join(tmp, ".lodestone"))).toBe(false);
  });

  it("schema-mismatch (low/below-v1) manifest triggers conservative mode", async () => {
    runInstallSteps(tmp, { writeClaudeMd: false });
    writeFileSync(
      path.join(tmp, ".lodestone", "install-manifest.json"),
      JSON.stringify({ schema_version: 0, installed_at: "x" })
    );

    expect(await uninstall([])).toBe(0);
    const stderr = err.mock.calls.flat().join("\n");
    expect(stderr.toLowerCase()).toMatch(/conservative mode/);
  });

  it("future-schema manifest REFUSES uninstall (Codex §19 YELLOW: no destructive fall-through)", async () => {
    runInstallSteps(tmp, { writeClaudeMd: false });
    // Simulate a future binary's manifest landing in this older binary's
    // tree. A v999 manifest may have additional required fields the older
    // binary doesn't know about; deleting `.lodestone/` would shred state
    // the future binary still depends on.
    writeFileSync(
      path.join(tmp, ".lodestone", "install-manifest.json"),
      JSON.stringify({
        schema_version: 999,
        installed_at: "2099-01-01T00:00:00.000Z",
        install_state: "complete",
        mcp_json: { action: "created", path: "/x" },
        claude_md: { action: "skipped" },
        gitignore: { action: "created", path: "/y" },
      })
    );

    // Distinct exit code (3) so CI/scripts can tell version-skew apart
    // from a normal non-zero failure.
    expect(await uninstall([])).toBe(3);
    const stderr = err.mock.calls.flat().join("\n");
    expect(stderr.toLowerCase()).toMatch(/refusing to uninstall|newer/);
    // .lodestone/ tree still on disk — uninstall did NOT touch it.
    expect(existsSync(path.join(tmp, ".lodestone"))).toBe(true);
    expect(
      existsSync(path.join(tmp, ".lodestone", "install-manifest.json"))
    ).toBe(true);
  });

  it("does not destroy an unparseable .mcp.json — fatal surface, preserves .lodestone/ for retry (Codex r2 §19 PARTIAL #1)", async () => {
    // v0.1.2 treated this as warn-not-fatal and continued to delete
    // .lodestone/. That violates §19's "only delete manifest AFTER all
    // referenced files confirmed gone" promise for the MCP surface — once
    // the manifest is gone, a retry has no provenance to undo the
    // (still-present) lodestone-mcp entry that the unparseable file may
    // contain. v0.1.3 escalates unparseable-when-init-authored to a fatal
    // partial failure that preserves .lodestone/ for retry.
    runInstallSteps(tmp, { writeClaudeMd: false });
    const garbage = "{this is not json at all";
    writeFileSync(path.join(tmp, ".mcp.json"), garbage);

    expect(await uninstall([])).toBe(1);
    // File untouched (the existing safety guarantee — we never overwrite
    // an unparseable file).
    expect(readFileSync(path.join(tmp, ".mcp.json"), "utf8")).toBe(garbage);
    // Manifest + .lodestone/ preserved so a re-run after fixing the JSON
    // can resume from recorded provenance.
    expect(existsSync(path.join(tmp, ".lodestone"))).toBe(true);
    expect(
      existsSync(path.join(tmp, ".lodestone", "install-manifest.json"))
    ).toBe(true);
    const stderr = err.mock.calls.flat().join("\n");
    expect(stderr.toLowerCase()).toMatch(/unparseable|preserved/);
  });

  it("conservative mode (no manifest) + unparseable .mcp.json: still fatal — file untouched, no .lodestone/ to preserve", async () => {
    // No manifest means we can't be sure init authored the .mcp.json
    // entry, BUT we still won't shred a file we can't parse, AND we
    // surface the failure so the operator knows the .mcp.json hasn't
    // been touched.
    const garbage = "{this is not json at all";
    writeFileSync(path.join(tmp, ".mcp.json"), garbage);

    expect(await uninstall([])).toBe(1);
    expect(readFileSync(path.join(tmp, ".mcp.json"), "utf8")).toBe(garbage);
    const stderr = err.mock.calls.flat().join("\n");
    expect(stderr.toLowerCase()).toMatch(/unparseable/);
  });

  it("nothing-installed: completely empty repo returns 0 with friendly message", async () => {
    expect(await uninstall([])).toBe(0);
    const stdout = log.mock.calls.flat().join("\n");
    expect(stdout.toLowerCase()).toContain("nothing to do");
  });

  it("pending-state manifest does NOT shred a foreign lodestone-mcp entry (Codex r2 §19 YELLOW)", async () => {
    // Simulate the partial-install window: a previous install on a
    // different machine left a `lodestone-mcp` entry pointing at THAT
    // machine's runtime path. A new `lodestone init` then started but
    // crashed BEFORE writeMcpJson() could overwrite the entry — leaving
    // a `pending` manifest whose mcp_json field still holds the staging
    // placeholder. v0.1.2's uninstall would remove the pre-existing
    // entry by key alone; v0.1.3 scopes removal to entries whose
    // `command` matches THIS install's runtime path.
    const foreignCommand =
      "/Users/someone-else/project/.lodestone/runtime/lodestone-mcp";
    const foreignEntry = {
      mcpServers: {
        "lodestone-mcp": { command: foreignCommand, args: [], env: {} },
      },
    };
    writeFileSync(
      path.join(tmp, ".mcp.json"),
      `${JSON.stringify(foreignEntry, null, 2)}\n`
    );

    // Manually craft a pending manifest with the staging mcp_json
    // placeholder (action="merged", path=<tmp>/.mcp.json — same shape
    // runInstallSteps writes before writeMcpJson runs).
    mkdirSync(path.join(tmp, ".lodestone"), { recursive: true });
    writeFileSync(
      path.join(tmp, ".lodestone", "install-manifest.json"),
      JSON.stringify(
        {
          schema_version: 2,
          installed_at: "2026-05-02T00:00:00.000Z",
          install_state: "pending",
          mcp_json: { action: "merged", path: path.join(tmp, ".mcp.json") },
          claude_md: { action: "skipped" },
          gitignore: {
            action: "noop",
            path: path.join(tmp, ".gitignore"),
          },
        },
        null,
        2
      )
    );

    expect(await uninstall([])).toBe(0);

    // Foreign lodestone-mcp entry preserved byte-identically.
    expect(readFileSync(path.join(tmp, ".mcp.json"), "utf8")).toBe(
      `${JSON.stringify(foreignEntry, null, 2)}\n`
    );
    // .lodestone/ removed (no other surface failed).
    expect(existsSync(path.join(tmp, ".lodestone"))).toBe(false);
  });

  it("complete-state manifest with matching runtime command DOES remove the entry (regression guard)", async () => {
    // A complete install with the canonical command should still be
    // removed — manifest-aware scoping only protects FOREIGN entries,
    // not our own.
    runInstallSteps(tmp, { writeClaudeMd: false });
    // The mcp.json now has the canonical entry pointing at this repo.
    const before = JSON.parse(
      readFileSync(path.join(tmp, ".mcp.json"), "utf8")
    );
    expect(before.mcpServers["lodestone-mcp"]).toBeDefined();

    expect(await uninstall([])).toBe(0);

    const after = JSON.parse(readFileSync(path.join(tmp, ".mcp.json"), "utf8"));
    expect(after.mcpServers["lodestone-mcp"]).toBeUndefined();
  });

  it("preserves the manifest on partial failure so a re-run can resume (Codex §19 RED)", async () => {
    // Stage an install with a friend-pre-existing CLAUDE.md (so manifest
    // records `appended` and uninstall will try to read+rewrite). Then
    // replace CLAUDE.md with a directory of the same name to force EISDIR
    // on readFileSync — the uninstall helper turns that into `unreadable`.
    // Pre-fix (§19 RED), .lodestone/ would still be removed even though
    // the partial failure left CLAUDE.md unreversed; a second uninstall
    // would lose all provenance and fall into conservative mode.
    // Post-fix, the manifest is preserved so the friend can fix the
    // underlying cause and re-run uninstall.
    const claudeMdPath = path.join(tmp, "CLAUDE.md");
    writeFileSync(claudeMdPath, "# friend body\n");
    runInstallSteps(tmp, { writeClaudeMd: true });
    expect(
      existsSync(path.join(tmp, ".lodestone", "install-manifest.json"))
    ).toBe(true);

    // Force EISDIR on the next CLAUDE.md read.
    rmSync(claudeMdPath, { force: true });
    mkdirSync(claudeMdPath);

    expect(await uninstall([])).toBe(1);

    // Manifest must STILL exist for a re-run to resume.
    expect(
      existsSync(path.join(tmp, ".lodestone", "install-manifest.json"))
    ).toBe(true);
    expect(existsSync(path.join(tmp, ".lodestone"))).toBe(true);
    const stderr = err.mock.calls.flat().join("\n");
    expect(stderr.toLowerCase()).toMatch(/unreadable|preserved/);
  });
});

// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { codexConfigPath, writeCodexConfig } from "../install/codex-config.js";
import { removeCodexConfigEntry } from "./codex-config-uninstall.js";

describe("removeCodexConfigEntry", () => {
  let tmp: string;
  const runtime = () => path.join(tmp, ".lodestone", "runtime", "lodestone-mcp");

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "lodestone-codex-uninstall-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("removes the whole config file when Lodestone created it and no other settings remain", () => {
    const manifest = writeCodexConfig(tmp);
    const result = removeCodexConfigEntry(tmp, manifest, {
      dryRun: false,
      expectedRuntimeCommand: runtime(),
    });
    expect(result.action).toBe("removed-file");
    expect(existsSync(codexConfigPath(tmp))).toBe(false);
  });

  it("removes only the lodestone-mcp entry when the file had other settings", () => {
    mkdirSync(path.dirname(codexConfigPath(tmp)), { recursive: true });
    writeFileSync(codexConfigPath(tmp), 'model = "gpt-5.5"\n');
    const manifest = writeCodexConfig(tmp);
    const result = removeCodexConfigEntry(tmp, manifest, {
      dryRun: false,
      expectedRuntimeCommand: runtime(),
    });
    expect(result.action).toBe("removed");
    const body = readFileSync(codexConfigPath(tmp), "utf8");
    expect(body).toContain('model = "gpt-5.5"');
    expect(body).not.toContain("lodestone-mcp");
  });

  it("respects provenance when lodestone-mcp points at another install", () => {
    const manifest = writeCodexConfig(tmp);
    writeFileSync(
      codexConfigPath(tmp),
      '[mcp_servers.lodestone-mcp]\ncommand = "/somewhere/else"\nargs = []\n'
    );
    const result = removeCodexConfigEntry(tmp, manifest, {
      dryRun: false,
      expectedRuntimeCommand: runtime(),
    });
    expect(result.action).toBe("respected-provenance");
    expect(readFileSync(codexConfigPath(tmp), "utf8")).toContain("/somewhere/else");
  });

  it("returns unparseable and leaves the file untouched on malformed TOML", () => {
    const manifest = writeCodexConfig(tmp);
    writeFileSync(codexConfigPath(tmp), "[mcp_servers");
    const result = removeCodexConfigEntry(tmp, manifest, {
      dryRun: false,
      expectedRuntimeCommand: runtime(),
    });
    expect(result.action).toBe("unparseable");
    expect(readFileSync(codexConfigPath(tmp), "utf8")).toBe("[mcp_servers");
  });

  it("conservative mode removes a local Codex entry without deleting the config file", () => {
    writeCodexConfig(tmp);
    const result = removeCodexConfigEntry(tmp, null, {
      dryRun: false,
      expectedRuntimeCommand: runtime(),
    });
    expect(result.action).toBe("removed");
    expect(existsSync(codexConfigPath(tmp))).toBe(true);
    expect(readFileSync(codexConfigPath(tmp), "utf8")).not.toContain("lodestone-mcp");
  });

  it("accepts symlink-equivalent runtime paths when removing Codex config", () => {
    const linkRoot = path.join(tmpdir(), `lodestone-codex-uninstall-link-${process.pid}-${Date.now()}`);
    symlinkSync(tmp, linkRoot, "dir");
    try {
      const manifest = writeCodexConfig(tmp);
      const result = removeCodexConfigEntry(linkRoot, manifest, {
        dryRun: false,
        expectedRuntimeCommand: path.join(linkRoot, ".lodestone", "runtime", "lodestone-mcp"),
      });
      expect(result.action).toBe("removed-file");
      expect(existsSync(codexConfigPath(tmp))).toBe(false);
    } finally {
      rmSync(linkRoot, { force: true });
    }
  });
});

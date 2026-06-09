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
import { parse as parseToml } from "smol-toml";
import { checkCodexConfig, codexConfigPath, writeCodexConfig } from "./codex-config.js";

describe("writeCodexConfig", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "lodestone-codex-config-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("creates project .codex/config.toml with lodestone-mcp server", () => {
    const result = writeCodexConfig(tmp);
    expect(result.action).toBe("created");
    expect(existsSync(codexConfigPath(tmp))).toBe(true);
    const parsed = parseToml(readFileSync(codexConfigPath(tmp), "utf8")) as {
      mcp_servers?: Record<string, { command?: string; cwd?: string; enabled?: boolean }>;
    };
    expect(parsed.mcp_servers?.["lodestone-mcp"]?.command).toBe(
      path.join(tmp, ".lodestone", "runtime", "lodestone-mcp")
    );
    expect(parsed.mcp_servers?.["lodestone-mcp"]?.cwd).toBe(tmp);
    expect(parsed.mcp_servers?.["lodestone-mcp"]?.enabled).toBe(true);
  });

  it("merges into an existing Codex config without removing other settings", () => {
    mkdirSync(path.dirname(codexConfigPath(tmp)), { recursive: true });
    writeFileSync(
      codexConfigPath(tmp),
      'model = "gpt-5.5"\n\n[mcp_servers.docs]\ncommand = "node"\nargs = ["server.js"]\n'
    );
    const result = writeCodexConfig(tmp);
    expect(result.action).toBe("merged");
    const body = readFileSync(codexConfigPath(tmp), "utf8");
    expect(body).toContain('model = "gpt-5.5"');
    expect(body).toContain("[mcp_servers.docs]");
    expect(body).toContain("[mcp_servers.lodestone-mcp]");
  });

  it("updates a stale lodestone-mcp entry idempotently", () => {
    mkdirSync(path.dirname(codexConfigPath(tmp)), { recursive: true });
    writeFileSync(
      codexConfigPath(tmp),
      '[mcp_servers.lodestone-mcp]\ncommand = "/old/path"\nargs = []\n'
    );
    const first = writeCodexConfig(tmp);
    const afterFirst = readFileSync(codexConfigPath(tmp), "utf8");
    const second = writeCodexConfig(tmp);
    expect(first.action).toBe("updated");
    expect(second.action).toBe("updated");
    expect(readFileSync(codexConfigPath(tmp), "utf8")).toBe(afterFirst);
  });

  it("throws on malformed existing TOML", () => {
    mkdirSync(path.dirname(codexConfigPath(tmp)), { recursive: true });
    writeFileSync(codexConfigPath(tmp), "[mcp_servers");
    expect(() => writeCodexConfig(tmp)).toThrow(/Failed to parse/);
  });

  it("doctor health accepts optional args/enabled defaults when command and cwd match", () => {
    mkdirSync(path.dirname(codexConfigPath(tmp)), { recursive: true });
    writeFileSync(
      codexConfigPath(tmp),
      `[mcp_servers.lodestone-mcp]\ncommand = "${path.join(
        tmp,
        ".lodestone",
        "runtime",
        "lodestone-mcp"
      )}"\ncwd = "${tmp}"\n`
    );
    expect(checkCodexConfig(tmp).state).toBe("ok");
  });

  it("doctor health accepts symlink-equivalent repo roots", () => {
    const linkRoot = path.join(tmpdir(), `lodestone-codex-link-${process.pid}-${Date.now()}`);
    symlinkSync(tmp, linkRoot, "dir");
    try {
      writeCodexConfig(tmp);
      expect(checkCodexConfig(linkRoot).state).toBe("ok");
    } finally {
      rmSync(linkRoot, { force: true });
    }
  });
});

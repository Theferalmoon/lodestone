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
import { removeMcpEntry } from "../../uninstall/mcp-config-uninstall.js";

describe("removeMcpEntry", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "lodestone-mcp-uninst-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeMcp(obj: unknown): string {
    const p = path.join(tmp, ".mcp.json");
    writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`);
    return p;
  }

  it("missing file → missing-file", () => {
    const r = removeMcpEntry(tmp);
    expect(r.action).toBe("missing-file");
  });

  it("entry absent → noop, file unchanged", () => {
    const before = { mcpServers: { other: { command: "x", args: [], env: {} } } };
    writeMcp(before);
    const beforeBuf = readFileSync(path.join(tmp, ".mcp.json"));
    const r = removeMcpEntry(tmp);
    expect(r.action).toBe("noop");
    expect(Buffer.compare(beforeBuf, readFileSync(path.join(tmp, ".mcp.json")))).toBe(0);
  });

  it("removes lodestone-mcp entry, preserves other entries byte-identically", () => {
    const before = {
      mcpServers: {
        "other-server": { command: "/usr/bin/other", args: ["--x"], env: { A: "B" } },
        "lodestone-mcp": { command: "/x/.lodestone/runtime/lodestone-mcp", args: [], env: {} },
        "third": { command: "/usr/bin/third", args: [], env: {} },
      },
    };
    writeMcp(before);
    const r = removeMcpEntry(tmp);
    expect(r.action).toBe("removed");
    const after = JSON.parse(readFileSync(path.join(tmp, ".mcp.json"), "utf8"));
    expect(after).toEqual({
      mcpServers: {
        "other-server": before.mcpServers["other-server"],
        "third": before.mcpServers["third"],
      },
    });
  });

  it("when only lodestone-mcp present: leaves empty mcpServers, file remains", () => {
    writeMcp({
      mcpServers: { "lodestone-mcp": { command: "x", args: [], env: {} } },
    });
    const r = removeMcpEntry(tmp);
    expect(r.action).toBe("removed");
    expect(existsSync(path.join(tmp, ".mcp.json"))).toBe(true);
    const after = JSON.parse(readFileSync(path.join(tmp, ".mcp.json"), "utf8"));
    expect(after).toEqual({ mcpServers: {} });
  });

  it("idempotent — second call returns noop, file byte-identical", () => {
    writeMcp({
      mcpServers: {
        "lodestone-mcp": { command: "x", args: [], env: {} },
        "other": { command: "y", args: [], env: {} },
      },
    });
    expect(removeMcpEntry(tmp).action).toBe("removed");
    const afterFirst = readFileSync(path.join(tmp, ".mcp.json"));
    const second = removeMcpEntry(tmp);
    expect(second.action).toBe("noop");
    expect(Buffer.compare(afterFirst, readFileSync(path.join(tmp, ".mcp.json")))).toBe(0);
  });

  it("preserves top-level fields outside mcpServers", () => {
    writeMcp({
      $schema: "https://example/mcp.json",
      mcpServers: {
        "lodestone-mcp": { command: "x", args: [], env: {} },
      },
      // Some hosts add their own keys (Claude Code does not, but be safe).
      _hostMeta: { lastSeen: "2026-01-01" },
    });
    expect(removeMcpEntry(tmp).action).toBe("removed");
    const after = JSON.parse(readFileSync(path.join(tmp, ".mcp.json"), "utf8"));
    expect(after.$schema).toBe("https://example/mcp.json");
    expect(after._hostMeta).toEqual({ lastSeen: "2026-01-01" });
  });

  it("unparseable JSON → unparseable, file unchanged", () => {
    const garbage = "{this is not json";
    writeFileSync(path.join(tmp, ".mcp.json"), garbage);
    const r = removeMcpEntry(tmp);
    expect(r.action).toBe("unparseable");
    expect(readFileSync(path.join(tmp, ".mcp.json"), "utf8")).toBe(garbage);
  });

  it("non-object root → unparseable", () => {
    writeFileSync(path.join(tmp, ".mcp.json"), "[]");
    const r = removeMcpEntry(tmp);
    expect(r.action).toBe("unparseable");
  });

  it("file with no mcpServers key → noop", () => {
    writeFileSync(path.join(tmp, ".mcp.json"), `${JSON.stringify({ other: 1 })}\n`);
    const r = removeMcpEntry(tmp);
    expect(r.action).toBe("noop");
  });

  it("dryRun: action = removed but file untouched", () => {
    writeMcp({
      mcpServers: { "lodestone-mcp": { command: "x", args: [], env: {} } },
    });
    const before = readFileSync(path.join(tmp, ".mcp.json"));
    const r = removeMcpEntry(tmp, { dryRun: true });
    expect(r.action).toBe("removed");
    expect(Buffer.compare(before, readFileSync(path.join(tmp, ".mcp.json")))).toBe(0);
  });
});

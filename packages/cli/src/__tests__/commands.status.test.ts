// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { main } from "../main.js";

describe("`lodestone status`", () => {
  let tmp: string;
  let originalCwd: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "lodestone-status-"));
    originalCwd = process.cwd();
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("outside a `.lodestone/`-having dir: prints clean error + exit 1", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = await main(["status"]);
    expect(code).toBe(1);
    const printed = err.mock.calls.flat().join("\n");
    expect(printed).toContain("No Lodestone index found");
    expect(printed).toContain("`lodestone init`");
    err.mockRestore();
  });

  it("with `.lodestone/` but no ready.json: prints clean error + exit 1", async () => {
    mkdirSync(path.join(tmp, ".lodestone"));
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = await main(["status"]);
    expect(code).toBe(1);
    const printed = err.mock.calls.flat().join("\n");
    expect(printed).toContain("No `ready.json`");
    err.mockRestore();
  });

  it("with valid ready.json: prints index summary, exits 0", async () => {
    mkdirSync(path.join(tmp, ".lodestone"));
    const indexedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    writeFileSync(
      path.join(tmp, ".lodestone", "ready.json"),
      JSON.stringify({
        schema_version: 1,
        ready: true,
        embedder: { id: "nomic-embed-text-v1.5", dim: 768, quant: "int8" },
        languages_indexed: ["typescript", "python"],
        indexed_at: indexedAt,
        commit_at_index: "abc1234",
        dirty_at_index: false,
        index_epoch: 42,
      })
    );

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await main(["status"]);
    expect(code).toBe(0);
    const printed = log.mock.calls.flat().join("\n");
    expect(printed).toContain("nomic-embed-text-v1.5");
    expect(printed).toContain("typescript");
    expect(printed).toContain("abc1234");
    expect(printed).toMatch(/m ago|s ago/);
    log.mockRestore();
  });

  it("`status --json` emits a single parseable JSON object", async () => {
    mkdirSync(path.join(tmp, ".lodestone"));
    writeFileSync(
      path.join(tmp, ".lodestone", "ready.json"),
      JSON.stringify({
        schema_version: 1,
        ready: true,
        embedder: { id: "nomic-embed-text-v1.5", dim: 768, quant: "int8" },
        languages_indexed: ["typescript"],
        indexed_at: new Date().toISOString(),
        commit_at_index: "abc1234",
        dirty_at_index: false,
        index_epoch: 1,
      })
    );

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await main(["status", "--json"]);
    expect(code).toBe(0);
    expect(log.mock.calls.length).toBe(1);
    const json = log.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(json);
    expect(parsed.lodestone_version).toBeDefined();
    expect(parsed.schema_version).toBe(1);
    expect(parsed.embedder.id).toBe("nomic-embed-text-v1.5");
    expect(parsed.indexed_at).toBeDefined();
    expect(parsed.index_epoch).toBe(1);
    log.mockRestore();
  });

  it("malformed ready.json: prints clean error + exit 1 (no stack trace)", async () => {
    mkdirSync(path.join(tmp, ".lodestone"));
    writeFileSync(path.join(tmp, ".lodestone", "ready.json"), "{not-json:");
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = await main(["status"]);
    expect(code).toBe(1);
    const printed = err.mock.calls.flat().join("\n");
    expect(printed).toContain("Failed to read");
    expect(printed).not.toContain("at Object."); // no V8 stack frames
    err.mockRestore();
  });

  it("coverage.json present: included in the report", async () => {
    mkdirSync(path.join(tmp, ".lodestone"));
    writeFileSync(
      path.join(tmp, ".lodestone", "ready.json"),
      JSON.stringify({
        schema_version: 1,
        ready: true,
        embedder: { id: "nomic-embed-text-v1.5", dim: 768, quant: "int8" },
        languages_indexed: ["typescript"],
        indexed_at: new Date().toISOString(),
        commit_at_index: "abc1234",
        dirty_at_index: false,
        index_epoch: 1,
      })
    );
    writeFileSync(
      path.join(tmp, ".lodestone", "coverage.json"),
      JSON.stringify({ coverage: 0.93 })
    );

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await main(["status", "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(log.mock.calls[0]?.[0] as string);
    expect(parsed.coverage).toBe(0.93);
    log.mockRestore();
  });
});

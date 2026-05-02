// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { main } from "../main.js";

interface MarkerFixture {
  schema_version?: number;
  lodestone_version?: string;
  ready?: boolean;
  embedder?: { id?: unknown; dim?: unknown; quant?: unknown };
  languages_indexed?: unknown;
  indexed_at?: string;
  commit_at_index?: string | null;
  dirty_at_index?: boolean;
  index_epoch?: number;
  writer_pid?: number;
  // Allow extras for "rejects unknown" tests.
  [k: string]: unknown;
}

function canonicalReadyJson(over: Partial<MarkerFixture> = {}): MarkerFixture {
  return {
    schema_version: 1,
    lodestone_version: "0.1.0",
    ready: true,
    embedder: { id: "nomic-embed-text-v1.5", dim: 768, quant: "int8" },
    languages_indexed: ["typescript", "python"],
    indexed_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    commit_at_index: "abc1234",
    dirty_at_index: false,
    index_epoch: 42,
    writer_pid: 12345,
    ...over,
  };
}

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

  it("with valid ready.json (canonical shape): prints index summary, exits 0", async () => {
    mkdirSync(path.join(tmp, ".lodestone"));
    writeFileSync(path.join(tmp, ".lodestone", "ready.json"), JSON.stringify(canonicalReadyJson()));

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

  it("`status --json` emits a single parseable JSON object with canonical fields", async () => {
    mkdirSync(path.join(tmp, ".lodestone"));
    writeFileSync(
      path.join(tmp, ".lodestone", "ready.json"),
      JSON.stringify(canonicalReadyJson({ index_epoch: 1 }))
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
    expect(parsed.clock_skew_detected).toBe(false);
    log.mockRestore();
  });

  it("malformed JSON: prints clean error + exit 1 (no V8 stack frames)", async () => {
    mkdirSync(path.join(tmp, ".lodestone"));
    writeFileSync(path.join(tmp, ".lodestone", "ready.json"), "{not-json:");
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = await main(["status"]);
    expect(code).toBe(1);
    const printed = err.mock.calls.flat().join("\n");
    expect(printed).toContain("Failed to read");
    expect(printed).not.toContain("at Object.");
    err.mockRestore();
  });

  it("coverage.json present: included in the report", async () => {
    mkdirSync(path.join(tmp, ".lodestone"));
    writeFileSync(path.join(tmp, ".lodestone", "ready.json"), JSON.stringify(canonicalReadyJson()));
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

  // Codex impl-003 B1/B7: input contract hardening.

  it("ready: false ⇒ exit 1 (degraded — surface to scripts)", async () => {
    mkdirSync(path.join(tmp, ".lodestone"));
    writeFileSync(
      path.join(tmp, ".lodestone", "ready.json"),
      JSON.stringify(canonicalReadyJson({ ready: false }))
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await main(["status"]);
    expect(code).toBe(1);
    log.mockRestore();
  });

  it("missing required field (lodestone_version): exit 1 with shape error before any partial stdout", async () => {
    mkdirSync(path.join(tmp, ".lodestone"));
    const partial = canonicalReadyJson();
    delete partial.lodestone_version;
    writeFileSync(path.join(tmp, ".lodestone", "ready.json"), JSON.stringify(partial));

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = await main(["status"]);
    expect(code).toBe(1);
    expect(log).not.toHaveBeenCalled(); // no partial stdout
    const printed = err.mock.calls.flat().join("\n");
    expect(printed).toContain("Invalid `ready.json` shape");
    log.mockRestore();
    err.mockRestore();
  });

  it("wrong-type languages_indexed (string instead of array): exit 1, no internal error", async () => {
    mkdirSync(path.join(tmp, ".lodestone"));
    writeFileSync(
      path.join(tmp, ".lodestone", "ready.json"),
      JSON.stringify(canonicalReadyJson({ languages_indexed: "typescript" as unknown as string[] }))
    );

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = await main(["status"]);
    expect(code).toBe(1);
    expect(log).not.toHaveBeenCalled();
    const printed = err.mock.calls.flat().join("\n");
    expect(printed).toContain("Invalid `ready.json` shape");
    expect(printed).not.toContain(".join is not a function");
    log.mockRestore();
    err.mockRestore();
  });

  it("partial embedder (missing dim): exit 1 with shape error", async () => {
    mkdirSync(path.join(tmp, ".lodestone"));
    writeFileSync(
      path.join(tmp, ".lodestone", "ready.json"),
      JSON.stringify(
        canonicalReadyJson({
          embedder: { id: "nomic-embed-text-v1.5", quant: "int8" } as unknown as MarkerFixture["embedder"],
        })
      )
    );
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = await main(["status"]);
    expect(code).toBe(1);
    expect(err.mock.calls.flat().join("\n")).toContain("Invalid `ready.json` shape");
    err.mockRestore();
  });

  it("future indexed_at: clock_skew_detected=true, staleness clamped to 0, warns on stderr", async () => {
    mkdirSync(path.join(tmp, ".lodestone"));
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    writeFileSync(
      path.join(tmp, ".lodestone", "ready.json"),
      JSON.stringify(canonicalReadyJson({ indexed_at: future }))
    );

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = await main(["status", "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(log.mock.calls[0]?.[0] as string);
    expect(parsed.clock_skew_detected).toBe(true);
    expect(parsed.staleness_seconds).toBe(0);
    log.mockRestore();
    err.mockRestore();
  });

  it("unknown extra field in ready.json: rejected by .strict()", async () => {
    mkdirSync(path.join(tmp, ".lodestone"));
    writeFileSync(
      path.join(tmp, ".lodestone", "ready.json"),
      JSON.stringify(canonicalReadyJson({ totally_made_up: 1 }))
    );
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = await main(["status"]);
    expect(code).toBe(1);
    expect(err.mock.calls.flat().join("\n")).toContain("Invalid `ready.json` shape");
    err.mockRestore();
  });

  it("corrupt coverage.json: surfaces as `coverage: null`, status still succeeds", async () => {
    mkdirSync(path.join(tmp, ".lodestone"));
    writeFileSync(path.join(tmp, ".lodestone", "ready.json"), JSON.stringify(canonicalReadyJson()));
    writeFileSync(path.join(tmp, ".lodestone", "coverage.json"), "{ this is broken json");

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await main(["status", "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(log.mock.calls[0]?.[0] as string);
    expect(parsed.coverage).toBeNull();
    log.mockRestore();
  });
});

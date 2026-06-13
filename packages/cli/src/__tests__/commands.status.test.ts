// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
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

function canonicalInstallManifest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 2,
    installed_at: new Date().toISOString(),
    install_state: "complete",
    reindex_state: "complete",
    mcp_json: { action: "created", path: path.join(process.cwd(), ".mcp.json") },
    claude_md: { action: "skipped" },
    gitignore: { action: "created", path: path.join(process.cwd(), ".gitignore") },
    ...over,
  };
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

describe("`lodestone status`", () => {
  let tmp: string;
  let originalCwd: string;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "lodestone-status-")));
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
      path.join(tmp, ".lodestone", "install-manifest.json"),
      JSON.stringify(canonicalInstallManifest({ reindex_state: "skipped" }))
    );
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
    expect(parsed.install_manifest.reindex_state).toBe("skipped");
    expect(parsed.repo_identity.cwd).toBe(tmp);
    expect(parsed.repo_identity.is_git_repo).toBe(false);
    expect(parsed.repo_identity.git_root).toBeNull();
    expect(parsed.repo_identity.mcp_json_path).toBe(path.join(tmp, ".mcp.json"));
    expect(parsed.index_consistency.indexed_commit).toBe("abc1234");
    expect(parsed.index_consistency.head_commit).toBeNull();
    expect(parsed.index_consistency.git_head_matches_index).toBeNull();
    expect(parsed.clock_skew_detected).toBe(false);
    log.mockRestore();
  });

  it("`status --json` reports repo identity and index mismatch in a git repo", async () => {
    git(tmp, ["init", "-q"]);
    writeFileSync(path.join(tmp, "tracked.txt"), "hello\n");
    git(tmp, ["add", "tracked.txt"]);
    git(tmp, [
      "-c",
      "user.name=Lodestone Test",
      "-c",
      "user.email=lodestone-test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      `core.hooksPath=${devNull}`,
      "commit",
      "-q",
      "-m",
      "init",
    ]);
    const head = git(tmp, ["rev-parse", "--short", "HEAD"]);
    mkdirSync(path.join(tmp, ".lodestone"));
    writeFileSync(
      path.join(tmp, ".lodestone", "ready.json"),
      JSON.stringify(canonicalReadyJson({ commit_at_index: "deadbee" }))
    );

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await main(["status", "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(log.mock.calls[0]?.[0] as string);
    expect(parsed.repo_identity.is_git_repo).toBe(true);
    expect(parsed.repo_identity.git_root).toBe(tmp);
    expect(parsed.repo_identity.head_commit).toBe(head);
    expect(parsed.index_consistency.git_head_matches_index).toBe(false);
    expect(parsed.index_consistency.warnings.join("\n")).toContain("deadbee");
    expect(parsed.index_consistency.warnings.join("\n")).toContain(head);
    log.mockRestore();
  });

  it("`status --json` reports unborn git repo identity without a HEAD commit", async () => {
    git(tmp, ["init", "-q"]);
    mkdirSync(path.join(tmp, ".lodestone"));
    writeFileSync(
      path.join(tmp, ".lodestone", "ready.json"),
      JSON.stringify(canonicalReadyJson({ commit_at_index: "abc1234" }))
    );

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await main(["status", "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(log.mock.calls[0]?.[0] as string);
    expect(parsed.repo_identity.is_git_repo).toBe(true);
    expect(parsed.repo_identity.git_root).toBe(tmp);
    expect(parsed.repo_identity.head_commit).toBeNull();
    expect(parsed.index_consistency.git_head_matches_index).toBeNull();
    log.mockRestore();
  });

  it("run from a subdirectory: points at the Git root Lodestone index", async () => {
    git(tmp, ["init", "-q"]);
    mkdirSync(path.join(tmp, ".lodestone"));
    mkdirSync(path.join(tmp, "src"));
    process.chdir(path.join(tmp, "src"));

    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = await main(["status"]);
    expect(code).toBe(1);
    const printed = err.mock.calls.flat().join("\n");
    expect(printed).toContain("A Lodestone index exists at Git root");
    expect(printed).toContain(tmp);
    expect(printed).toContain("intentional subproject");
    err.mockRestore();
  });

  it("missing ready.json surfaces failed reindex_state from install manifest", async () => {
    mkdirSync(path.join(tmp, ".lodestone"));
    writeFileSync(
      path.join(tmp, ".lodestone", "install-manifest.json"),
      JSON.stringify(canonicalInstallManifest({ reindex_state: "failed" }))
    );
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = await main(["status"]);
    expect(code).toBe(1);
    const printed = err.mock.calls.flat().join("\n");
    expect(printed).toContain("reindex_state=failed");
    expect(printed).toContain("last install-side reindex failed");
    err.mockRestore();
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

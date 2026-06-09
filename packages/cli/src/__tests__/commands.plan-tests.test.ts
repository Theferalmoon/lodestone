// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { OutputSink } from "../ui/output.js";
import {
  parsePlanTestsArgv,
  planTests,
  planTestsForPaths,
} from "../commands/plan-tests.js";

function commandList(commands: readonly { command: string }[]): string[] {
  return commands.map((entry) => entry.command);
}

function captureOutput(): OutputSink & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    info(msg: string): void {
      stdout.push(msg);
    },
    success(msg: string): void {
      stdout.push(msg);
    },
    warn(msg: string): void {
      stderr.push(msg);
    },
    error(msg: string): void {
      stderr.push(msg);
    },
    json(obj: unknown): void {
      stdout.push(JSON.stringify(obj));
    },
  };
}

describe("plan-tests command", () => {
  it("parses supported options and usage errors", () => {
    expect(parsePlanTestsArgv([])).toEqual({ help: false, json: false, staged: false });
    expect(parsePlanTestsArgv(["--json", "--staged"])).toEqual({
      help: false,
      json: true,
      staged: true,
    });
    expect(parsePlanTestsArgv(["--base", "origin/main"])).toEqual({
      base: "origin/main",
      help: false,
      json: false,
      staged: false,
    });
    expect(parsePlanTestsArgv(["--base=HEAD~1"])).toEqual({
      base: "HEAD~1",
      help: false,
      json: false,
      staged: false,
    });
    expect(parsePlanTestsArgv(["--base"]).error).toMatch(/requires/);
    expect(parsePlanTestsArgv(["--base", "-h"]).error).toMatch(/requires/);
    expect(parsePlanTestsArgv(["--base=-h"]).error).toMatch(/requires/);
    expect(parsePlanTestsArgv(["--base", "main", "--staged"]).error).toMatch(/either/);
    expect(parsePlanTestsArgv(["--wat"]).error).toMatch(/Unknown option/);
  });

  it("maps CLI and docs changes to narrow smoke gates plus full repository gates", () => {
    const plan = planTestsForPaths(
      [
        "packages/cli/src/commands/plan-tests.ts",
        "docs/README.md",
        "scripts/docs/friend-docs-build.py",
      ],
      "unit paths"
    );

    expect(plan.scopes).toEqual(["cli", "docs", "scripts"]);
    expect(commandList(plan.fast_smoke)).toEqual([
      "pnpm --filter @lodestone/cli typecheck",
      "pnpm --filter @lodestone/cli test",
      "pnpm --filter @lodestone/e2e exec vitest run --reporter=verbose docs.test.ts",
      "pnpm docs:friend",
      "python3 -m py_compile scripts/docs/friend-docs-build.py",
    ]);
    expect(commandList(plan.full_confidence)).toEqual([
      "pnpm docs:friend",
      "pnpm -r build",
      "pnpm -r typecheck",
      "pnpm test",
    ]);
    expect(plan.notes.join("\n")).toContain("docs/internal");
  });

  it("adds the isolated watcher gate when watcher code changes", () => {
    const plan = planTestsForPaths(["packages/ingest/src/watcher/index.ts"]);
    expect(commandList(plan.fast_smoke)).toContain("pnpm --filter @lodestone/ingest test");
    expect(commandList(plan.fast_smoke)).toContain(
      "pnpm --filter @lodestone/ingest exec vitest run --coverage.enabled=false src/watcher/__tests__/watcher.test.ts"
    );
  });

  it("uses git diff plus untracked files by default and emits JSON for agents", async () => {
    const out = captureOutput();
    const capturedArgs: readonly string[][] = [];
    const code = await planTests(["--json"], {
      cwd: "/repo",
      output: out,
      execFileSync(_file, args) {
        capturedArgs.push(args);
        if (args[0] === "ls-files") return "packages/cli/src/commands/plan-tests.ts\0";
        if (args.includes("--cached")) return "docs/some file.md\0";
        return "packages/shared/src/config/schema.ts\0";
      },
    });

    expect(code).toBe(0);
    expect(capturedArgs).toEqual([
      ["diff", "--name-only", "-z", "--"],
      ["diff", "--name-only", "-z", "--cached", "--"],
      ["ls-files", "--others", "--exclude-standard", "-z"],
    ]);
    const parsed = JSON.parse(out.stdout[0] ?? "{}") as { changed_paths?: string[]; scopes?: string[] };
    expect(parsed.changed_paths).toContain("docs/some file.md");
    expect(parsed.scopes).toEqual(["cli", "shared", "docs"]);
  });

  it("can plan from staged changes", async () => {
    const out = captureOutput();
    let capturedArgs: readonly string[] = [];
    const code = await planTests(["--staged"], {
      cwd: "/repo",
      output: out,
      execFileSync(_file, args) {
        capturedArgs = args;
        return "packages/mcp-server/src/tools.ts\n";
      },
    });

    expect(code).toBe(0);
    expect(capturedArgs).toEqual(["diff", "--name-only", "-z", "--cached", "--"]);
    expect(out.stdout.join("\n")).toContain("@lodestone/mcp-server");
  });

  it("treats root bootstrap/config changes as bootstrap smoke and does not mark fixture package.json as release", () => {
    const plan = planTestsForPaths([
      "__tests__/bootstrap.test.ts",
      "vitest.config.ts",
      "e2e/synthetic-demo-repo/package.json",
    ]);
    expect(plan.scopes).toEqual(["bootstrap", "e2e", "workspace"]);
    expect(commandList(plan.fast_smoke)).toContain("pnpm test:bootstrap");
    expect(commandList(plan.fast_smoke)).toContain("pnpm --filter @lodestone/e2e test");
    expect(commandList(plan.fast_smoke)).not.toContain("pnpm install --frozen-lockfile");
  });

  it("runs bootstrap smoke for root config changes even without root test files", () => {
    const plan = planTestsForPaths(["vitest.config.ts"]);
    expect(plan.scopes).toEqual(["bootstrap", "workspace"]);
    expect(commandList(plan.fast_smoke)).toContain("pnpm test:bootstrap");
  });

  it("returns a runtime error when git path discovery fails", async () => {
    const out = captureOutput();
    const code = await planTests([], {
      output: out,
      execFileSync() {
        throw new Error("spawn git ENOENT");
      },
    });
    expect(code).toBe(1);
    expect(out.stderr.join("\n")).toContain("Unable to read changed paths from git");
  });

  it("prints help without consulting git", async () => {
    const out = captureOutput();
    const code = await planTests(["--help"], { output: out });
    expect(code).toBe(0);
    expect(out.stdout.join("\n")).toContain("lodestone plan-tests");
  });

  it("returns a usage error for invalid options", async () => {
    const out = captureOutput();
    const code = await planTests(["--base"], { output: out });
    expect(code).toBe(2);
    expect(out.stderr.join("\n")).toContain("--base requires");
  });
});

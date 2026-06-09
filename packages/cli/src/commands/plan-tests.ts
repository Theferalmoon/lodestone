// SPDX-License-Identifier: Apache-2.0
// `lodestone plan-tests` — deterministic test-impact guidance for agents
// working on the Lodestone repo itself.
import { execFileSync } from "node:child_process";
import type { OutputSink } from "../ui/output.js";
import { output as defaultOutput } from "../ui/output.js";

export interface PlanTestsOptions {
  base?: string;
  help: boolean;
  json: boolean;
  staged: boolean;
  error?: string;
}

export interface TestPlanCommand {
  command: string;
  reason: string;
}

export interface TestPlan {
  source: string;
  changed_paths: readonly string[];
  scopes: readonly string[];
  fast_smoke: readonly TestPlanCommand[];
  full_confidence: readonly TestPlanCommand[];
  notes: readonly string[];
}

interface MutableTestPlan {
  source: string;
  changed_paths: string[];
  scopes: string[];
  fast_smoke: TestPlanCommand[];
  full_confidence: TestPlanCommand[];
  notes: string[];
}

type GitExec = (
  file: string,
  args: readonly string[],
  options: { cwd: string; encoding: "utf8"; stdio: ["ignore", "pipe", "pipe"] }
) => string;

export interface PlanTestsDeps {
  cwd?: string;
  execFileSync?: GitExec;
  output?: OutputSink;
}

type Scope =
  | "bootstrap"
  | "cli"
  | "docs"
  | "e2e"
  | "ingest"
  | "mcp-server"
  | "release"
  | "scripts"
  | "shared"
  | "workspace";

const SCOPE_ORDER: readonly Scope[] = [
  "bootstrap",
  "cli",
  "shared",
  "ingest",
  "mcp-server",
  "e2e",
  "docs",
  "scripts",
  "release",
  "workspace",
];

const PACKAGE_SCOPES: Readonly<Record<Scope, { filter: string; label: string } | undefined>> = {
  bootstrap: undefined,
  cli: { filter: "@lodestone/cli", label: "CLI package" },
  shared: { filter: "@lodestone/shared", label: "shared package" },
  ingest: { filter: "@lodestone/ingest", label: "ingest package" },
  "mcp-server": { filter: "@lodestone/mcp-server", label: "MCP server package" },
  e2e: { filter: "@lodestone/e2e", label: "end-to-end package" },
  docs: undefined,
  release: undefined,
  scripts: undefined,
  workspace: undefined,
};

export function parsePlanTestsArgv(argv: readonly string[]): PlanTestsOptions {
  const opts: PlanTestsOptions = { help: false, json: false, staged: false };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
    if (token === "--help" || token === "-h") {
      opts.help = true;
    } else if (token === "--json") {
      opts.json = true;
    } else if (token === "--staged") {
      opts.staged = true;
    } else if (token === "--base") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        return { ...opts, error: "--base requires a git ref value." };
      }
      opts.base = value;
      i += 1;
    } else if (token.startsWith("--base=")) {
      const value = token.slice("--base=".length);
      if (value === "" || value.startsWith("-")) {
        return { ...opts, error: "--base requires a git ref value." };
      }
      opts.base = value;
    } else {
      return { ...opts, error: `Unknown option: ${token}` };
    }
  }

  if (opts.staged && opts.base !== undefined) {
    return { ...opts, error: "Use either --staged or --base, not both." };
  }

  return opts;
}

export async function planTests(
  argv: readonly string[],
  deps: PlanTestsDeps = {}
): Promise<number> {
  const opts = parsePlanTestsArgv(argv);
  const out = deps.output ?? defaultOutput;

  if (opts.error !== undefined) {
    out.error(opts.error);
    out.error("Run `lodestone plan-tests --help` for usage.");
    return 2;
  }

  if (opts.help) {
    printPlanTestsHelp(out);
    return 0;
  }

  const changed = readChangedPaths(opts, deps);
  if (!changed.ok) {
    out.error(changed.error);
    return 1;
  }

  const plan = planTestsForPaths(changed.paths, changed.source);
  if (opts.json) {
    out.json(plan);
  } else {
    printHumanPlan(plan, out);
  }
  return 0;
}

export function planTestsForPaths(
  changedPaths: readonly string[],
  source = "provided paths"
): TestPlan {
  const normalizedPaths = uniqueSorted(
    changedPaths.map((p) => p.trim().replaceAll("\\", "/")).filter((p) => p.length > 0)
  );
  const scopes = classifyScopes(normalizedPaths);
  const plan: MutableTestPlan = {
    source,
    changed_paths: normalizedPaths,
    scopes,
    fast_smoke: [],
    full_confidence: [],
    notes: [],
  };

  if (normalizedPaths.length === 0) {
    plan.notes.push("No changed paths found. Use the baseline gates only when validating the environment.");
    addCommand(plan.fast_smoke, "pnpm -r typecheck", "baseline sanity check for an empty diff");
    addCommand(plan.full_confidence, "pnpm test", "full repository test pass");
    return freezePlan(plan);
  }

  for (const scope of scopes) {
    const pkg = PACKAGE_SCOPES[scope];
    if (pkg !== undefined) {
      addCommand(plan.fast_smoke, `pnpm --filter ${pkg.filter} typecheck`, `${pkg.label} changed`);
      addCommand(plan.fast_smoke, `pnpm --filter ${pkg.filter} test`, `${pkg.label} changed`);
    }
  }

  if (scopes.includes("ingest") && normalizedPaths.some((p) => p.startsWith("packages/ingest/src/watcher/"))) {
    addCommand(
      plan.fast_smoke,
      "pnpm --filter @lodestone/ingest exec vitest run --coverage.enabled=false src/watcher/__tests__/watcher.test.ts",
      "watcher code changed; isolate the historically flaky watcher coverage first"
    );
  }

  if (scopes.includes("docs") || scopes.includes("cli")) {
    addCommand(
      plan.fast_smoke,
      "pnpm --filter @lodestone/e2e exec vitest run --reporter=verbose docs.test.ts",
      "docs or CLI command surface changed; guard against stale command/path references"
    );
  }

  if (scopes.includes("bootstrap")) {
    addCommand(plan.fast_smoke, "pnpm test:bootstrap", "root bootstrap tests or config changed");
  }

  if (shouldRegenerateFriendDocs(normalizedPaths)) {
    addCommand(
      plan.fast_smoke,
      "pnpm docs:friend",
      "friend-facing docs source changed; regenerate Word, HTML, and package-local docs"
    );
  }

  const pythonDocsScripts = normalizedPaths.filter(
    (p) => p.startsWith("scripts/docs/") && p.endsWith(".py")
  );
  if (pythonDocsScripts.length > 0) {
    addCommand(
      plan.fast_smoke,
      `python3 -m py_compile ${pythonDocsScripts.map(shellQuote).join(" ")}`,
      "Python docs builder changed"
    );
  }

  if (normalizedPaths.some((p) => p.startsWith("scripts/mcpb/"))) {
    addCommand(plan.fast_smoke, "pnpm mcpb:claude", "Claude Desktop bundle packer changed");
  }

  if (scopes.includes("release")) {
    addCommand(
      plan.fast_smoke,
      "pnpm install --frozen-lockfile",
      "workspace manifests or lockfile changed"
    );
  }

  if (scopes.includes("workspace")) {
    addCommand(plan.fast_smoke, "pnpm -r typecheck", "workspace-level config changed");
  }

  if (plan.fast_smoke.length === 0) {
    addCommand(plan.fast_smoke, "pnpm -r typecheck", "changed paths do not map to a narrower gate");
  }

  if (shouldRegenerateFriendDocs(normalizedPaths)) {
    addCommand(
      plan.full_confidence,
      "pnpm docs:friend",
      "keep generated docs synchronized before final gates"
    );
  }
  if (scopes.includes("release")) {
    addCommand(
      plan.full_confidence,
      "pnpm install --frozen-lockfile",
      "verify dependency metadata before repository gates"
    );
  }
  addCommand(plan.full_confidence, "pnpm -r build", "compile all workspace packages");
  addCommand(plan.full_confidence, "pnpm -r typecheck", "typecheck all workspace packages");
  addCommand(plan.full_confidence, "pnpm test", "run the complete unit and e2e suite");

  if (scopes.includes("docs")) {
    plan.notes.push("Keep docs/internal/ out of public docs and package artifacts.");
  }
  if (scopes.includes("release")) {
    plan.notes.push("After release-manifest edits, verify generated checksums and friend installer pins.");
  }

  return freezePlan(plan);
}

function readChangedPaths(
  opts: PlanTestsOptions,
  deps: PlanTestsDeps
): { ok: true; paths: string[]; source: string } | { ok: false; error: string } {
  const cwd = deps.cwd ?? process.cwd();
  const exec: GitExec =
    deps.execFileSync ??
    ((file, args, options) => execFileSync(file, [...args], options) as string);
  const commands = gitPathCommands(opts);
  try {
    const raw = commands
      .map((args) =>
        exec("git", args, {
          cwd,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        })
      )
      .join("\0");
    return {
      ok: true,
      paths: uniqueSorted(splitGitPathOutput(raw)),
      source: commands.map((args) => `git ${args.join(" ")}`).join(" + "),
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message.split(/\r?\n/)[0] : String(err);
    return {
      ok: false,
      error: `Unable to read changed paths from git: ${detail}`,
    };
  }
}

function gitPathCommands(opts: PlanTestsOptions): string[][] {
  if (opts.staged) {
    return [["diff", "--name-only", "-z", "--cached", "--"]];
  }
  if (opts.base !== undefined) {
    return [
      ["diff", "--name-only", "-z", opts.base, "--"],
      ["ls-files", "--others", "--exclude-standard", "-z"],
    ];
  }
  return [
    ["diff", "--name-only", "-z", "--"],
    ["diff", "--name-only", "-z", "--cached", "--"],
    ["ls-files", "--others", "--exclude-standard", "-z"],
  ];
}

function classifyScopes(paths: readonly string[]): Scope[] {
  const scopes = new Set<Scope>();
  for (const p of paths) {
    if (isBootstrapPath(p)) scopes.add("bootstrap");
    if (p.startsWith("packages/cli/")) scopes.add("cli");
    else if (p.startsWith("packages/shared/")) scopes.add("shared");
    else if (p.startsWith("packages/ingest/")) scopes.add("ingest");
    else if (p.startsWith("packages/mcp-server/")) scopes.add("mcp-server");
    else if (p.startsWith("e2e/")) scopes.add("e2e");

    if (isDocsPath(p)) scopes.add("docs");
    if (p.startsWith("scripts/")) scopes.add("scripts");
    if (isReleasePath(p)) scopes.add("release");
    if (isWorkspacePath(p)) scopes.add("workspace");
  }
  return SCOPE_ORDER.filter((scope) => scopes.has(scope));
}

function isBootstrapPath(pathname: string): boolean {
  return (
    pathname.startsWith("__tests__/") ||
    pathname === "package.json" ||
    pathname === "pnpm-lock.yaml" ||
    pathname === "pnpm-workspace.yaml" ||
    pathname === "tsconfig.base.json" ||
    pathname === "vitest.config.ts"
  );
}

function isDocsPath(pathname: string): boolean {
  return (
    pathname === "README.md" ||
    pathname.endsWith("/README.md") ||
    pathname.startsWith("docs/") ||
    pathname === "LICENSE-AUTHORIZATION.md"
  );
}

function isReleasePath(pathname: string): boolean {
  return (
    pathname === "package.json" ||
    pathname === "pnpm-lock.yaml" ||
    pathname === "release-manifest.json" ||
    pathname === "network-manifest.json" ||
    /^packages\/[^/]+\/package\.json$/.test(pathname) ||
    pathname === "e2e/package.json" ||
    pathname.startsWith(".github/workflows/")
  );
}

function isWorkspacePath(pathname: string): boolean {
  return (
    pathname === ".gitignore" ||
    pathname === ".npmrc" ||
    pathname === "tsconfig.base.json" ||
    pathname === "vitest.config.ts" ||
    pathname === "pnpm-workspace.yaml" ||
    pathname.startsWith(".git-hooks/") ||
    pathname.startsWith(".husky/")
  );
}

function shouldRegenerateFriendDocs(paths: readonly string[]): boolean {
  return paths.some(
    (p) =>
      p === "README.md" ||
      (p.startsWith("docs/") && !p.startsWith("docs/internal/")) ||
      p.startsWith("scripts/docs/")
  );
}

function addCommand(target: TestPlanCommand[], command: string, reason: string): void {
  if (target.some((entry) => entry.command === command)) return;
  target.push({ command, reason });
}

function printPlanTestsHelp(out: OutputSink): void {
  out.info(
    [
      "lodestone plan-tests — suggest a test plan for the current Lodestone diff.",
      "",
      "USAGE",
      "  lodestone plan-tests [--staged | --base <ref>] [--json]",
      "",
      "OPTIONS",
      "  --staged      Plan from staged changes instead of working-tree changes.",
      "  --base <ref>  Plan from `git diff --name-only <ref> --`.",
      "  --json        Emit a machine-readable packet for another agent.",
      "  -h, --help    Show this help message.",
    ].join("\n")
  );
}

function printHumanPlan(plan: TestPlan, out: OutputSink): void {
  out.info("lodestone plan-tests");
  out.info(`source: ${plan.source}`);
  out.info(`changed paths: ${plan.changed_paths.length}`);
  out.info(`scopes: ${plan.scopes.length > 0 ? plan.scopes.join(", ") : "none"}`);
  printCommandSection("FAST SMOKE", plan.fast_smoke, out);
  printCommandSection("FULL CONFIDENCE", plan.full_confidence, out);
  if (plan.notes.length > 0) {
    out.info("");
    out.info("NOTES");
    for (const note of plan.notes) out.info(`  - ${note}`);
  }
}

function printCommandSection(
  title: string,
  commands: readonly TestPlanCommand[],
  out: OutputSink
): void {
  out.info("");
  out.info(title);
  if (commands.length === 0) {
    out.info("  (none)");
    return;
  }
  for (const entry of commands) {
    out.info(`  ${entry.command}`);
    out.info(`    ${entry.reason}`);
  }
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function splitGitPathOutput(raw: string): string[] {
  const chunks = raw.includes("\0") ? raw.split("\0") : raw.split(/\r?\n/);
  return chunks.map((line) => line.trim()).filter(Boolean);
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function freezePlan(plan: MutableTestPlan): TestPlan {
  return {
    source: plan.source,
    changed_paths: Object.freeze([...plan.changed_paths]),
    scopes: Object.freeze([...plan.scopes]),
    fast_smoke: Object.freeze([...plan.fast_smoke]),
    full_confidence: Object.freeze([...plan.full_confidence]),
    notes: Object.freeze([...plan.notes]),
  };
}

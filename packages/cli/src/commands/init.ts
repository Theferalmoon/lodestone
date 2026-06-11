// SPDX-License-Identifier: Apache-2.0
// `lodestone init` — orchestrates the friend-facing install side-effects
// (write .mcp.json, optional CLAUDE.md augment, .gitignore patch, install
// manifest). The ingest/cluster/seed-skills pipeline is a §05+ concern;
// this section wires only the install-step orchestration that runs after
// that pipeline (or, in v0, after a no-op ingest).
//
// MANIFEST SCHEMA v2 (Codex §04 YELLOW — transactional install):
//   v1 wrote the manifest LAST. If `.mcp.json`/CLAUDE.md/.gitignore writes
//   succeeded but the manifest write failed, the repo had a partial install
//   with no provenance for `lodestone uninstall` to use. Worse: if the
//   process was killed mid-install, the same hole opened.
//
//   v2 fix: write the manifest FIRST with `install_state: "pending"` and a
//   stub for each surface, then perform each side effect, updating the
//   manifest after each step. On full success, promote `install_state` to
//   `"complete"`. A `pending` manifest on disk tells uninstall it has a
//   crashed-mid-install repo and should clean up best-effort.
//
//   v2 also tracks `reindex_state` so `lodestone init` can write a
//   well-formed manifest even when the post-install ingest pipeline fails:
//   install side effects are intact, friend re-runs `lodestone reindex`.
import path from "node:path";
import { lodestoneSubpath, canonicalLodestoneDir } from "@lodestone/shared";
import { writeFileAtomic } from "../install/atomic.js";
import { augmentClaudeMd, type AugmentClaudeMdResult } from "../install/claude-md.js";
import { updateGitignore, type UpdateGitignoreResult } from "../install/gitignore.js";
import { writeMcpJson, type McpConfigResult } from "../install/mcp-config.js";
import {
  codexConfigPath,
  writeCodexConfig,
  type CodexConfigResult,
} from "../install/codex-config.js";
import { installRuntime } from "../install/runtime.js";
import { writeLodestoneToml } from "../install/toml.js";
import { printClaudeMdSnippet } from "../install/snippet.js";
import { runReindex, isBundledModelMissing } from "./reindex.js";
import { output } from "../ui/output.js";

export interface InitOptions {
  writeClaudeMd: boolean;
  pro: boolean;
  dryRun: boolean;
  clients: readonly ClientTarget[];
  clientError?: string;
  /**
   * POST-§20 Issue C: `init` runs the ingest pipeline by default so a friend
   * gets a fully-indexed project from a single command. `--no-reindex` skips
   * the heavy step for tests, dry-runs, and operators who want to chain a
   * custom embedder loader into a follow-up `lodestone reindex`.
   */
  noReindex: boolean;
}

export type ClientTarget = "mcp" | "codex";

const MCP_CLIENT_ALIASES = new Set([
  "mcp",
  "claude-code",
  "cursor",
  "cline",
  "cmndclaw",
]);
const CLIENT_USAGE = "mcp, codex, all, claude-code, cursor, cline, cmndclaw";

/**
 * `install_state` semantics (schema v2):
 *  - `"pending"`: manifest written up-front; one or more surfaces have not
 *    yet been confirmed applied. A pending manifest left on disk signals a
 *    crashed-mid-install repo. Uninstall treats this as "best-effort
 *    cleanup".
 *  - `"complete"`: every install surface succeeded. Uninstall reverses
 *    cleanly using the recorded provenance.
 *
 * `reindex_state` semantics (schema v2, optional):
 *  - `"complete"`: post-install ingest pipeline ran and produced
 *    `ready.json`.
 *  - `"failed"`: install side effects landed cleanly, but the ingest
 *    pipeline failed. Friend can re-run `lodestone reindex` to retry. The
 *    install manifest stays valid for uninstall.
 *  - `"skipped"`: `--no-reindex` was passed.
 *  - absent: `runInstallSteps()` was called directly (test path, or a
 *    consumer that orchestrates reindex separately).
 */
export interface InstallManifest {
  schema_version: 2;
  installed_at: string;
  install_state: "pending" | "complete";
  reindex_state?: "complete" | "failed" | "skipped";
  mcp_json: McpConfigResult;
  claude_md: AugmentClaudeMdResult;
  gitignore: UpdateGitignoreResult;
  codex_config?: CodexConfigResult;
}

export function parseInitArgv(argv: readonly string[]): InitOptions {
  const clients = new Set<ClientTarget>();
  let clientError: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
    let value: string | undefined;
    if (token === "--client") {
      value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        clientError = `--client requires a value: ${CLIENT_USAGE}`;
        break;
      }
      i += 1;
    } else if (token.startsWith("--client=")) {
      value = token.slice("--client=".length);
      if (value === "") {
        clientError = `--client requires a value: ${CLIENT_USAGE}`;
        break;
      }
    } else {
      continue;
    }
    const normalizedValue = value.toLowerCase();
    if (normalizedValue === "all") {
      clients.add("mcp");
      clients.add("codex");
    } else if (MCP_CLIENT_ALIASES.has(normalizedValue)) {
      clients.add("mcp");
    } else if (normalizedValue === "codex") {
      clients.add("codex");
    } else {
      clientError = `Unknown client '${value}'. Known clients: ${CLIENT_USAGE}`;
      break;
    }
  }
  return {
    writeClaudeMd: argv.includes("--write-claude-md"),
    pro: argv.includes("--pro"),
    dryRun: argv.includes("--dry-run"),
    clients: [...clients],
    ...(clientError !== undefined ? { clientError } : {}),
    noReindex: argv.includes("--no-reindex"),
  };
}

function initArgvIncludesHelp(argv: readonly string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

function printInitHelp(): void {
  output.info(
    [
      "lodestone init — set up Lodestone in this project.",
      "",
      "USAGE",
      "  lodestone init [--write-claude-md] [--client <name>] [--no-reindex]",
      "  lodestone init --dry-run",
      "  lodestone init --help",
      "",
      "OPTIONS",
      "  --write-claude-md  Add the Lodestone usage block to CLAUDE.md.",
      `  --client <name>     Configure a client integration: ${CLIENT_USAGE}.`,
      "  --no-reindex        Install config only; skip the initial KG build.",
      "  --dry-run           Show planned writes without touching the filesystem.",
      "  --pro               Reserved for v0.5+; exits without changing files.",
      "  -h, --help          Show this help message.",
    ].join("\n")
  );
}

/**
 * Runs the install side-effects against `repoRoot` and returns the manifest.
 * Exposed for testability — the CLI handler delegates to this so tests can
 * exercise idempotency without spawning the binary.
 *
 * Transactional install (schema v2):
 *   1. Write a `pending` manifest with placeholder entries so even if
 *      step 2 throws, uninstall sees a manifest and knows install was
 *      attempted.
 *   2. Run each surface (mcp.json → CLAUDE.md → .gitignore). After each
 *      success, rewrite the manifest with the freshly recorded action.
 *      On any thrown error, the partially-written manifest is left on
 *      disk in `pending` state — uninstall reads it and reverses what it
 *      can.
 *   3. Promote `install_state` to `"complete"` once every surface has
 *      been applied.
 */
export function runInstallSteps(
  repoRoot: string,
  opts: { writeClaudeMd: boolean; clients?: readonly ClientTarget[] }
): InstallManifest {
  // Manifest lives inside .lodestone/ — make sure the dir exists before writing.
  // canonicalLodestoneDir creates the parent (cwd) but not .lodestone itself;
  // writeFileAtomic mkdir -p's the immediate parent, so this is safe.
  canonicalLodestoneDir(repoRoot);
  const manifestPath = lodestoneSubpath(repoRoot, "installManifest");

  // Stage a pending manifest BEFORE any side effect. Each surface field
  // gets a placeholder action that uninstall reads as "not applied" so a
  // crash mid-install doesn't trick uninstall into trying to reverse a
  // step that never ran.
  const stagingMcp: McpConfigResult = {
    action: "merged",
    path: path.join(repoRoot, ".mcp.json"),
  };
  const stagingClaude: AugmentClaudeMdResult = { action: "skipped" };
  const stagingGitignore: UpdateGitignoreResult = {
    action: "noop",
    path: path.join(repoRoot, ".gitignore"),
  };
  const clients = opts.clients ?? [];
  const manifest: InstallManifest = {
    schema_version: 2,
    installed_at: new Date().toISOString(),
    install_state: "pending",
    mcp_json: stagingMcp,
    claude_md: stagingClaude,
    gitignore: stagingGitignore,
    ...(clients.includes("codex")
      ? { codex_config: { action: "merged", path: codexConfigPath(repoRoot) } }
      : {}),
  };
  const writeManifest = (): void => {
    writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  };
  writeManifest();

  // Each surface: do the work, update the manifest, persist. The interim
  // writes are cheap (one small JSON file) and let uninstall reverse a
  // partial install precisely.
  // Write the minimal lodestone.toml the MCP server boot path requires.
  // v0.1.4 fix — prior init never wrote it; MCP server crashed on first
  // boot with ENOENT. Idempotent: preserves an operator-edited file.
  writeLodestoneToml(repoRoot);
  // Install runtime shim FIRST so the path .mcp.json points at actually
  // exists by the time the editor reads .mcp.json. v0.1.4 fix — prior
  // builds wrote .mcp.json with a command path that was never created.
  installRuntime(repoRoot);
  manifest.mcp_json = writeMcpJson(repoRoot);
  writeManifest();

  if (clients.includes("codex")) {
    manifest.codex_config = writeCodexConfig(repoRoot);
    writeManifest();
  }

  manifest.claude_md = opts.writeClaudeMd
    ? augmentClaudeMd({ write: true, repoRoot })
    : (() => {
        printClaudeMdSnippet();
        return augmentClaudeMd({ write: false, repoRoot });
      })();
  writeManifest();

  manifest.gitignore = updateGitignore(repoRoot);
  writeManifest();

  // All surfaces applied — promote to `complete`.
  manifest.install_state = "complete";
  writeManifest();

  return manifest;
}

export async function init(argv: readonly string[]): Promise<number> {
  if (initArgvIncludesHelp(argv)) {
    printInitHelp();
    return 0;
  }

  const opts = parseInitArgv(argv);
  const cwd = process.cwd();

  if (opts.clientError !== undefined) {
    output.error(opts.clientError);
    return 2;
  }

  if (opts.pro) {
    output.warn("Pro mode is v0.5+ work; no files were changed.");
    output.warn("Run `lodestone init` without `--pro` for the v0 friend-mode install.");
    return 0;
  }

  if (opts.dryRun) {
    output.info("--dry-run set; no install side-effects will be applied.");
    output.info(`would write: ${path.join(cwd, ".mcp.json")}`);
    output.info(`would patch: ${path.join(cwd, ".gitignore")}`);
    if (opts.clients.includes("codex")) {
      output.info(`would write: ${codexConfigPath(cwd)}`);
    }
    if (opts.writeClaudeMd) {
      output.info(`would augment: ${path.join(cwd, "CLAUDE.md")}`);
    }
    output.info(`would write: ${lodestoneSubpath(cwd, "installManifest")}`);
    if (!opts.noReindex) {
      output.info("would run: ingest pipeline (reindex). Pass --no-reindex to skip.");
    }
    return 0;
  }

  let manifest: InstallManifest;
  try {
    manifest = runInstallSteps(cwd, {
      writeClaudeMd: opts.writeClaudeMd,
      clients: opts.clients,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    output.error(`Install failed: ${detail}`);
    return 1;
  }

  output.success("Lodestone install complete.");
  output.info(`  .mcp.json:        ${manifest.mcp_json.action} (${manifest.mcp_json.path})`);
  output.info(`  .gitignore:       ${manifest.gitignore.action} (${manifest.gitignore.path})`);
  if (manifest.codex_config !== undefined) {
    output.info(
      `  Codex config:      ${manifest.codex_config.action} (${manifest.codex_config.path})`
    );
    output.info(
      "  note: Codex loads project .codex/config.toml only after this repo is trusted."
    );
  }
  output.info(
    `  CLAUDE.md:        ${manifest.claude_md.action}${
      manifest.claude_md.path ? ` (${manifest.claude_md.path})` : ""
    }`
  );
  output.info(`  install manifest: ${lodestoneSubpath(cwd, "installManifest")}`);
  // When the friend has marker-bracketed CLAUDE.md content from a prior
  // install, we never rewrite it (so their hand-edits survive). The cost is
  // that future Lodestone snippet updates won't reach them automatically.
  // Tell them how to refresh — without this, a stale snippet is invisible.
  if (manifest.claude_md.action === "already_present") {
    output.info("");
    output.info(
      "  note: CLAUDE.md markers found — your edits are preserved. To refresh"
    );
    output.info(
      "        the Lodestone snippet, delete the BEGIN/END LODESTONE block"
    );
    output.info("        and re-run `lodestone init --write-claude-md`.");
  }

  // POST-§20 Issue C: run the ingest pipeline so a friend gets a queryable
  // index from a single command. Suppress with `--no-reindex` for tests,
  // CI dry-runs, or operators chaining a custom embedder via `lodestone
  // reindex` afterwards.
  if (opts.noReindex) {
    output.info("");
    output.info("Skipping ingest (--no-reindex). Run `lodestone reindex` to build the index.");
    recordReindexState(cwd, manifest, "skipped");
    return 0;
  }

  output.info("");
  try {
    await runReindex(cwd);
  } catch (err) {
    // Codex §04 YELLOW: install side effects are intact and the manifest is
    // already `complete` — the failure is post-install. Reflect that in the
    // manifest (`reindex_state: "failed"`) so future tooling and the friend
    // can see exactly which step did not finish, and exit with a distinct
    // non-zero code so CI can distinguish install failure (exit 1, no
    // manifest) from reindex failure (exit 2, manifest present + valid).
    const detail = err instanceof Error ? err.message : String(err);
    output.error(`Reindex failed: ${detail}`);
    output.error("Install side-effects are intact; rerun `lodestone reindex` to retry.");
    if (isBundledModelMissing(err)) {
      output.error("");
      output.error(
        "Hint: bundled embedder weights are missing. Reinstall the matching lite/full release"
      );
      output.error(
        "or use a future build with published setup-models pins."
      );
    }
    recordReindexState(cwd, manifest, "failed");
    return 2;
  }

  recordReindexState(cwd, manifest, "complete");
  output.info("");
  output.info("Next: open Claude Code in this directory.");
  return 0;
}

/**
 * Update the install manifest with a final `reindex_state`. This is a
 * best-effort write — if the manifest can't be re-written, we swallow the
 * error rather than mask the original outcome (success or reindex failure)
 * with a manifest-write failure.
 */
function recordReindexState(
  cwd: string,
  manifest: InstallManifest,
  state: NonNullable<InstallManifest["reindex_state"]>
): void {
  manifest.reindex_state = state;
  try {
    const manifestPath = lodestoneSubpath(cwd, "installManifest");
    writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  } catch {
    /* best-effort — do not mask the upstream outcome */
  }
}

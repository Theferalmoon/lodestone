// SPDX-License-Identifier: Apache-2.0
// `lodestone init` — orchestrates the friend-facing install side-effects
// (write .mcp.json, optional CLAUDE.md augment, .gitignore patch, install
// manifest). The ingest/cluster/seed-skills pipeline is a §05+ concern;
// this section wires only the install-step orchestration that runs after
// that pipeline (or, in v0, after a no-op ingest).
import path from "node:path";
import { lodestoneSubpath, canonicalLodestoneDir } from "@lodestone/shared";
import { writeFileAtomic } from "../install/atomic.js";
import { augmentClaudeMd, type AugmentClaudeMdResult } from "../install/claude-md.js";
import { updateGitignore, type UpdateGitignoreResult } from "../install/gitignore.js";
import { writeMcpJson, type McpConfigResult } from "../install/mcp-config.js";
import { printClaudeMdSnippet } from "../install/snippet.js";
import { output } from "../ui/output.js";

export interface InitOptions {
  writeClaudeMd: boolean;
  pro: boolean;
  dryRun: boolean;
}

export interface InstallManifest {
  schema_version: 1;
  installed_at: string;
  mcp_json: McpConfigResult;
  claude_md: AugmentClaudeMdResult;
  gitignore: UpdateGitignoreResult;
}

export function parseInitArgv(argv: readonly string[]): InitOptions {
  return {
    writeClaudeMd: argv.includes("--write-claude-md"),
    pro: argv.includes("--pro"),
    dryRun: argv.includes("--dry-run"),
  };
}

/**
 * Runs the install side-effects against `repoRoot` and returns the manifest.
 * Exposed for testability — the CLI handler delegates to this so tests can
 * exercise idempotency without spawning the binary.
 */
export function runInstallSteps(
  repoRoot: string,
  opts: { writeClaudeMd: boolean }
): InstallManifest {
  const mcp = writeMcpJson(repoRoot);
  const claudeMd = opts.writeClaudeMd
    ? augmentClaudeMd({ write: true, repoRoot })
    : (() => {
        printClaudeMdSnippet();
        return augmentClaudeMd({ write: false, repoRoot });
      })();
  const gitignore = updateGitignore(repoRoot);

  const manifest: InstallManifest = {
    schema_version: 1,
    installed_at: new Date().toISOString(),
    mcp_json: mcp,
    claude_md: claudeMd,
    gitignore,
  };
  // Manifest lives inside .lodestone/ — make sure the dir exists before writing.
  // canonicalLodestoneDir creates the parent (cwd) but not .lodestone itself;
  // writeFileAtomic mkdir -p's the immediate parent, so this is safe.
  canonicalLodestoneDir(repoRoot);
  const manifestPath = lodestoneSubpath(repoRoot, "installManifest");
  writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return manifest;
}

export async function init(argv: readonly string[]): Promise<number> {
  const opts = parseInitArgv(argv);
  const cwd = process.cwd();

  if (opts.pro) {
    output.warn("`--pro` is not yet implemented in this build (filled by §22).");
  }

  if (opts.dryRun) {
    output.info("--dry-run set; no install side-effects will be applied.");
    output.info(`would write: ${path.join(cwd, ".mcp.json")}`);
    output.info(`would patch: ${path.join(cwd, ".gitignore")}`);
    if (opts.writeClaudeMd) {
      output.info(`would augment: ${path.join(cwd, "CLAUDE.md")}`);
    }
    output.info(`would write: ${lodestoneSubpath(cwd, "installManifest")}`);
    return 0;
  }

  let manifest: InstallManifest;
  try {
    manifest = runInstallSteps(cwd, { writeClaudeMd: opts.writeClaudeMd });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    output.error(`Install failed: ${detail}`);
    return 1;
  }

  output.success("Lodestone install complete.");
  output.info(`  .mcp.json:        ${manifest.mcp_json.action} (${manifest.mcp_json.path})`);
  output.info(`  .gitignore:       ${manifest.gitignore.action} (${manifest.gitignore.path})`);
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
  output.info("");
  output.info("Next: open Claude Code in this directory.");
  return 0;
}

// SPDX-License-Identifier: Apache-2.0
// `lodestone uninstall` — idempotent reverse of `lodestone init`. Reads the
// install manifest written by §04, undoes each surface in reverse order, and
// removes the `.lodestone/` tree last (because everything before it reads the
// manifest from inside the tree).
//
// Flags:
//   --dry-run     plan only, no filesystem writes
//   --keep-index  remove agent integration (.mcp.json, CLAUDE.md, .gitignore)
//                 but keep .lodestone/ data
//
// Exit codes: 0 on success, 1 on partial failure (any helper returned a
// non-recoverable result), 2 on argv error (currently impossible — all flags
// are optional and unknown ones are silently ignored to match init's parser).
import { output } from "../ui/output.js";
import { readInstallManifest } from "../uninstall/manifest-reader.js";
import { removeMcpEntry } from "../uninstall/mcp-config-uninstall.js";
import { removeClaudeMdBlock } from "../uninstall/claude-md-uninstall.js";
import { removeGitignoreLine } from "../uninstall/gitignore-uninstall.js";
import { removeLodestoneTree } from "../uninstall/index-removal.js";
import type { InstallManifest } from "./init.js";

export interface UninstallOptions {
  dryRun: boolean;
  keepIndex: boolean;
}

export function parseUninstallArgv(argv: readonly string[]): UninstallOptions {
  return {
    dryRun: argv.includes("--dry-run"),
    keepIndex: argv.includes("--keep-index"),
  };
}

export async function uninstall(argv: readonly string[]): Promise<number> {
  const opts = parseUninstallArgv(argv);
  const cwd = process.cwd();

  if (opts.dryRun) {
    output.info("--dry-run set; no filesystem changes will be applied.");
  }

  // 1. Read manifest. Missing/invalid → conservative mode (no CLAUDE.md or
  //    .gitignore reversal; only .mcp.json entry + .lodestone/ tree).
  const manifestResult = readInstallManifest(cwd);
  let manifest: InstallManifest | null = null;
  if (manifestResult.ok) {
    manifest = manifestResult.manifest;
  } else if (manifestResult.reason === "missing") {
    output.warn(
      "No install manifest found — running in conservative mode (skipping CLAUDE.md and .gitignore reversal)."
    );
  } else {
    output.warn(
      `Install manifest unreadable (${manifestResult.reason}) — running in conservative mode.${
        manifestResult.detail ? ` detail: ${manifestResult.detail}` : ""
      }`
    );
  }

  let exitCode = 0;

  // 2. Reverse each surface in reverse order of init. Mutate the .mcp.json
  //    last among the agent-facing files so a Ctrl-C mid-uninstall leaves the
  //    Lodestone integration in the most-broken-but-recoverable state (the
  //    .mcp.json entry still pointing at the just-deleted .lodestone/ runtime
  //    is a clean "MCP server not found" error rather than a half-edited file).
  //
  //    Order per spec §19 implementation outline:
  //      a. CLAUDE.md stanza
  //      b. .gitignore line
  //      c. .mcp.json entry
  //      d. .lodestone/ tree (last — manifest lives in here)
  const claudeRes = removeClaudeMdBlock(cwd, manifest?.claude_md ?? null, {
    dryRun: opts.dryRun,
  });
  reportClaude(claudeRes, opts.dryRun);
  if (claudeRes.action === "unreadable") exitCode = 1;

  const gitRes = removeGitignoreLine(cwd, manifest?.gitignore ?? null, {
    dryRun: opts.dryRun,
  });
  reportGitignore(gitRes, opts.dryRun);
  if (gitRes.action === "unreadable") exitCode = 1;

  const mcpRes = removeMcpEntry(cwd, { dryRun: opts.dryRun });
  reportMcp(mcpRes, opts.dryRun);
  if (mcpRes.action === "unparseable") {
    // Unparseable .mcp.json is a warn-not-fatal — friend's hand-edit is
    // probably in flight; we'd rather leave their config intact than shred it.
    // No exit-code escalation.
  }

  const treeRes = await removeLodestoneTree(cwd, {
    dryRun: opts.dryRun,
    keepIndex: opts.keepIndex,
  });
  reportTree(treeRes, opts.dryRun, opts.keepIndex);
  if (treeRes.action === "failed") exitCode = 1;

  // 3. Summary line — friend reads this and knows whether to re-run.
  const noopFully =
    claudeRes.action !== "removed-block" &&
    claudeRes.action !== "removed-file" &&
    gitRes.action !== "removed-line" &&
    gitRes.action !== "removed-file" &&
    mcpRes.action !== "removed" &&
    treeRes.action !== "removed";

  if (noopFully && exitCode === 0) {
    output.info("");
    output.info("Lodestone is not installed in this directory; nothing to do.");
    return 0;
  }

  output.info("");
  if (opts.dryRun) {
    output.info("Dry-run complete. Re-run without --dry-run to apply.");
  } else if (exitCode === 0) {
    output.success(
      `Lodestone uninstalled${
        treeRes.action === "removed" && treeRes.bytesFreed > 0
          ? ` (${formatBytes(treeRes.bytesFreed)} freed)`
          : ""
      }.`
    );
  } else {
    output.error("Uninstall completed with errors. See messages above.");
  }

  return exitCode;
}

function reportClaude(
  res: ReturnType<typeof removeClaudeMdBlock>,
  dryRun: boolean
): void {
  const verb = dryRun ? "would " : "";
  switch (res.action) {
    case "removed-block":
      output.info(`  CLAUDE.md:        ${verb}remove block (${res.path})`);
      break;
    case "removed-file":
      output.info(`  CLAUDE.md:        ${verb}delete file (${res.path})`);
      break;
    case "respected-provenance":
      output.info(
        `  CLAUDE.md:        skipped (init did not author this file)`
      );
      break;
    case "unreadable":
      output.error(`  CLAUDE.md:        unreadable — ${res.detail ?? ""}`);
      break;
    case "noop":
      output.info(`  CLAUDE.md:        nothing to do`);
      break;
  }
}

function reportGitignore(
  res: ReturnType<typeof removeGitignoreLine>,
  dryRun: boolean
): void {
  const verb = dryRun ? "would " : "";
  switch (res.action) {
    case "removed-line":
      output.info(`  .gitignore:       ${verb}remove .lodestone/ line (${res.path})`);
      break;
    case "removed-file":
      output.info(`  .gitignore:       ${verb}delete file (${res.path})`);
      break;
    case "respected-provenance":
      output.info(`  .gitignore:       skipped (line was pre-existing)`);
      break;
    case "unreadable":
      output.error(`  .gitignore:       unreadable — ${res.detail ?? ""}`);
      break;
    case "noop":
      output.info(`  .gitignore:       nothing to do`);
      break;
  }
}

function reportMcp(
  res: ReturnType<typeof removeMcpEntry>,
  dryRun: boolean
): void {
  const verb = dryRun ? "would " : "";
  switch (res.action) {
    case "removed":
      output.info(`  .mcp.json:        ${verb}remove lodestone-mcp entry (${res.path})`);
      break;
    case "noop":
      output.info(`  .mcp.json:        nothing to do`);
      break;
    case "missing-file":
      output.info(`  .mcp.json:        not present`);
      break;
    case "unparseable":
      output.warn(
        `  .mcp.json:        unparseable — leaving alone (${res.detail ?? ""})`
      );
      break;
  }
}

function reportTree(
  res: Awaited<ReturnType<typeof removeLodestoneTree>>,
  dryRun: boolean,
  keepIndex: boolean
): void {
  const verb = dryRun ? "would " : "";
  switch (res.action) {
    case "removed":
      output.info(
        `  .lodestone/:      ${verb}remove tree (${res.path}, ~${formatBytes(res.bytesFreed)})`
      );
      break;
    case "noop":
      if (keepIndex) {
        output.info(`  .lodestone/:      preserved (--keep-index)`);
      } else {
        output.info(`  .lodestone/:      not present`);
      }
      break;
    case "failed":
      output.error(`  .lodestone/:      removal failed — ${res.detail ?? ""}`);
      break;
  }
}

/**
 * Cheap byte-count formatter — KB / MB / GB binary. Friend-facing only;
 * never used for arithmetic.
 */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

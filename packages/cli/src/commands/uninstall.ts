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
import path from "node:path";
import { output } from "../ui/output.js";
import { readInstallManifest } from "../uninstall/manifest-reader.js";
import { removeMcpEntry } from "../uninstall/mcp-config-uninstall.js";
import { removeClaudeMdBlock } from "../uninstall/claude-md-uninstall.js";
import { removeGitignoreLine } from "../uninstall/gitignore-uninstall.js";
import { removeCodexConfigEntry } from "../uninstall/codex-config-uninstall.js";
import { removeLodestoneTree } from "../uninstall/index-removal.js";
import type { InstallManifest } from "./init.js";

// The absolute path the install side wrote into `.mcp.json` as the
// lodestone-mcp `command` (see install/mcp-config.ts — kept in sync by
// hand because the install module is part of a different surface and
// importing it would pull the entire install tree into the uninstall
// path). Codex r2 §19 YELLOW: passed to removeMcpEntry as the manifest-
// scoped removal guard so we never shred a foreign install's entry.
function expectedRuntimeCommandFor(repoRoot: string): string {
  return path.join(repoRoot, ".lodestone", "runtime", "lodestone-mcp");
}

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
  //    Future-schema → ABORT, never delete state we don't understand
  //    (Codex §19 YELLOW: an older uninstaller would otherwise shred a
  //    newer install's recovery info).
  const manifestResult = readInstallManifest(cwd);
  let manifest: InstallManifest | null = null;
  if (manifestResult.ok) {
    manifest = manifestResult.manifest;
  } else if (manifestResult.reason === "future-schema") {
    output.error(
      `Install manifest is from a newer Lodestone build than this binary supports.${
        manifestResult.detail ? ` ${manifestResult.detail}` : ""
      }`
    );
    output.error(
      "Refusing to uninstall — an older binary could shred state it does not understand."
    );
    output.error(
      "Upgrade lodestone (`npm i -g @lodestone/cli`) and re-run `lodestone uninstall`."
    );
    return 3;
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

  const codexRes = removeCodexConfigEntry(cwd, manifest?.codex_config, {
    dryRun: opts.dryRun,
    expectedRuntimeCommand: expectedRuntimeCommandFor(cwd),
  });
  reportCodex(codexRes, opts.dryRun);
  if (codexRes.action === "unparseable") exitCode = 1;

  // Codex r2 §19 YELLOW: when we have a manifest, scope MCP removal to
  // entries whose `command` matches THIS install's runtime path. Without
  // this, a pending-state manifest (mcp_json still holds the staging
  // placeholder, real `writeMcpJson` never ran) would let uninstall
  // shred a pre-existing `lodestone-mcp` entry from a different install
  // that the pending one was about to overwrite. Conservative mode (no
  // manifest) keeps the v0.1.2 remove-by-key behavior — tested elsewhere
  // in this file as the "missing manifest" contract.
  const mcpRes = removeMcpEntry(cwd, {
    dryRun: opts.dryRun,
    ...(manifest !== null
      ? { expectedRuntimeCommand: expectedRuntimeCommandFor(cwd) }
      : {}),
  });
  reportMcp(mcpRes, opts.dryRun);
  if (mcpRes.action === "unparseable") {
    // Codex r2 §19 PARTIAL #1: `.mcp.json` removal failures are part of
    // the fatal-surface set. The original safety guarantee is preserved
    // — we still don't overwrite a file we can't parse — but we no
    // longer fall through to deleting `.lodestone/`. Without this
    // escalation the manifest would be shredded while the unparseable
    // `.mcp.json` may still contain a `lodestone-mcp` entry pointing at
    // the just-deleted runtime; a re-run would then have no provenance
    // to clean up that entry. Treating this as fatal preserves
    // `.lodestone/` (and the manifest inside it) so a friend can fix
    // the JSON and re-run `lodestone uninstall` to finish the job.
    exitCode = 1;
  }

  // Codex §19 RED: only delete `.lodestone/` (and the manifest inside it)
  // AFTER every reversible surface confirmed clean. If anything above
  // failed, keep the manifest so a re-run of `lodestone uninstall` can
  // resume from the recorded provenance instead of falling into
  // conservative mode and skipping CLAUDE.md/.gitignore on the retry.
  let treeRes: Awaited<ReturnType<typeof removeLodestoneTree>>;
  if (exitCode !== 0) {
    treeRes = {
      action: "noop",
      path: cwd,
      bytesFreed: 0,
    };
    output.warn(
      "  .lodestone/:      preserved (prior surface failed; re-run uninstall after fixing the error above)"
    );
  } else {
    treeRes = await removeLodestoneTree(cwd, {
      dryRun: opts.dryRun,
      keepIndex: opts.keepIndex,
    });
    reportTree(treeRes, opts.dryRun, opts.keepIndex);
    if (treeRes.action === "failed") exitCode = 1;
  }

  // 3. Summary line — friend reads this and knows whether to re-run.
  const noopFully =
    claudeRes.action !== "removed-block" &&
    claudeRes.action !== "removed-file" &&
    gitRes.action !== "removed-line" &&
    gitRes.action !== "removed-file" &&
    codexRes.action !== "removed" &&
    codexRes.action !== "removed-file" &&
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

function reportCodex(
  res: ReturnType<typeof removeCodexConfigEntry>,
  dryRun: boolean
): void {
  const verb = dryRun ? "would " : "";
  switch (res.action) {
    case "removed":
      output.info(`  .codex/config:   ${verb}remove lodestone-mcp entry (${res.path})`);
      break;
    case "removed-file":
      output.info(`  .codex/config:   ${verb}delete file (${res.path})`);
      break;
    case "respected-provenance":
      output.info(`  .codex/config:   skipped (entry belongs to another install)`);
      break;
    case "unparseable":
      output.error(`  .codex/config:   unparseable — ${res.detail}`);
      break;
    case "noop":
      output.info(`  .codex/config:   nothing to do`);
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
    case "foreign-entry":
      output.info(
        `  .mcp.json:        skipped (lodestone-mcp entry belongs to a different install — ${res.detail ?? ""})`
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

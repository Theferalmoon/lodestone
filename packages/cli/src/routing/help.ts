// SPDX-License-Identifier: Apache-2.0
// Top-level --help and --version text. Subcommand-level help is each
// command's responsibility.
import { VERSION, COMMIT_HASH } from "../version.js";

/** Subcommand list — single source of truth for help + dispatch. */
export interface SubcommandSummary {
  name: string;
  description: string;
}

export const SUBCOMMANDS: readonly SubcommandSummary[] = [
  { name: "init", description: "Set up Lodestone in this project (the magic-moment command)." },
  { name: "status", description: "Show index coverage, last ingest, staleness, embedder identity." },
  { name: "reindex", description: "Re-ingest the project (use --from-scratch for a clean rebuild)." },
  { name: "doctor", description: "Probe the environment (Node, git, RAM, proxies, CoreML, WSL2)." },
  { name: "plan-tests", description: "Suggest targeted and full test gates for the current diff." },
  { name: "seed-skills", description: "Pre-populate common-pattern skills from project structure." },
  { name: "upgrade", description: "Pull latest Lodestone and run any required schema migrations." },
  { name: "uninstall", description: "Cleanly reverse a Lodestone install (idempotent)." },
  {
    name: "client-smoke",
    description: "Emit real-client MCP smoke commands for supported agent clients.",
  },
  {
    name: "setup-models",
    description:
      "Opt-in: download embedder weights to .lodestone/models/ (consent-gated).",
  },
] as const;

export function printVersionLine(): void {
  console.log(`lodestone ${VERSION} (${COMMIT_HASH})`);
}

export function printTopLevelHelp(): void {
  const longest = SUBCOMMANDS.reduce((n, s) => Math.max(n, s.name.length), 0);
  const lines: string[] = [
    "lodestone — a project-local code-aware Knowledge Graph for coding agents.",
    "",
    "USAGE",
    "  lodestone <command> [args]",
    "  lodestone --version   Print version and commit hash",
    "  lodestone --help      Show this message",
    "",
    "COMMANDS",
    ...SUBCOMMANDS.map(
      (s) => `  ${s.name.padEnd(longest)}   ${s.description}`
    ),
    "",
    "Run `lodestone <command> --help` for command-specific options.",
  ];
  console.log(lines.join("\n"));
}

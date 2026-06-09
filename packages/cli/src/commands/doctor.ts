// SPDX-License-Identifier: Apache-2.0
// `lodestone doctor` — lightweight environment + install-state probe.
// Deeper probes (client adapters, WSL2 path heuristics, proxy validation) land
// in later slices, but this command must already surface the install manifest
// state because `init` records whether the post-install reindex failed.
import { existsSync } from "node:fs";

import { lodestoneSubpath } from "@lodestone/shared";
import {
  checkCodexConfig,
  type CodexConfigHealth,
} from "../install/codex-config.js";
import { output } from "../ui/output.js";
import { readInstallManifest } from "../uninstall/manifest-reader.js";

export interface DoctorOptions {
  clients: readonly DoctorClientTarget[];
  clientError?: string;
}

export type DoctorClientTarget = "codex";

export function parseDoctorArgv(argv: readonly string[]): DoctorOptions {
  const clients = new Set<DoctorClientTarget>();
  let clientError: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
    let value: string | undefined;
    if (token === "--client") {
      value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        clientError = "--client requires a value: codex or all";
        break;
      }
      i += 1;
    } else if (token.startsWith("--client=")) {
      value = token.slice("--client=".length);
      if (value === "") {
        clientError = "--client requires a value: codex or all";
        break;
      }
    } else {
      continue;
    }
    if (value === "codex" || value === "all") {
      clients.add("codex");
    } else {
      clientError = `Unknown client '${value}'. Known clients: codex, all`;
      break;
    }
  }
  return {
    clients: [...clients],
    ...(clientError !== undefined ? { clientError } : {}),
  };
}

export async function doctor(argv: readonly string[]): Promise<number> {
  const opts = parseDoctorArgv(argv);
  const cwd = process.cwd();
  const fmt = (label: string, value: string): string => `  ${label.padEnd(18)} ${value}`;

  if (opts.clientError !== undefined) {
    output.error(opts.clientError);
    return 2;
  }

  let degraded = false;

  output.info("lodestone doctor");
  output.info(fmt("node", process.version));
  output.info(fmt("offline mode", process.env.LODESTONE_OFFLINE === "1" ? "enabled" : "disabled"));
  output.info(fmt("ready marker", existsSync(lodestoneSubpath(cwd, "ready")) ? "present" : "missing"));

  const manifest = readInstallManifest(cwd);
  let manifestRequiresCodex = false;
  if (manifest.ok) {
    manifestRequiresCodex = manifest.manifest.codex_config !== undefined;
    output.info(fmt("install manifest", "present"));
    output.info(fmt("install state", manifest.manifest.install_state));
    output.info(fmt("reindex state", manifest.manifest.reindex_state ?? "not recorded"));
    if (manifest.manifest.install_state === "pending" || manifest.manifest.reindex_state === "failed") {
      degraded = true;
      output.error(
        "Install manifest is not fully healthy; rerun `lodestone reindex` or `lodestone uninstall` after reviewing the failure."
      );
    }
  } else {
    output.info(fmt("install manifest", manifest.reason));
    if (manifest.detail) output.info(fmt("manifest detail", manifest.detail));
    if (manifest.reason !== "missing") degraded = true;
  }

  if (opts.clients.includes("codex") || manifestRequiresCodex) {
    const health = checkCodexConfig(cwd);
    output.info(fmt("codex config", formatCodexHealth(health)));
    if (health.state !== "ok") {
      degraded = true;
      output.error(`Codex config is not healthy: ${formatCodexHealth(health)}.`);
      output.error("Run `lodestone init --client codex --no-reindex` to refresh it.");
    } else {
      output.info("  note: Codex loads project .codex/config.toml only after this repo is trusted.");
    }
  }

  return degraded ? 1 : 0;
}

function formatCodexHealth(health: CodexConfigHealth): string {
  switch (health.state) {
    case "ok":
      return `ok (${health.path})`;
    case "missing-file":
      return `missing file (${health.path})`;
    case "missing-entry":
      return `missing lodestone-mcp entry (${health.path})`;
    case "stale":
      return `stale (${health.detail})`;
    case "invalid":
      return `invalid (${health.detail})`;
    case "unparseable":
      return `unparseable (${health.detail})`;
  }
}

// SPDX-License-Identifier: Apache-2.0
// `lodestone doctor` — lightweight environment + install-state probe.
// Deeper probes (client adapters, WSL2 path heuristics, proxy validation) land
// in later slices, but this command must already surface the install manifest
// state because `init` records whether the post-install reindex failed.
import { existsSync } from "node:fs";

import { lodestoneSubpath } from "@lodestone/shared";
import { output } from "../ui/output.js";
import { readInstallManifest } from "../uninstall/manifest-reader.js";

export async function doctor(_argv: readonly string[]): Promise<number> {
  const cwd = process.cwd();
  const fmt = (label: string, value: string): string => `  ${label.padEnd(18)} ${value}`;
  let degraded = false;

  output.info("lodestone doctor");
  output.info(fmt("node", process.version));
  output.info(fmt("offline mode", process.env.LODESTONE_OFFLINE === "1" ? "enabled" : "disabled"));
  output.info(fmt("ready marker", existsSync(lodestoneSubpath(cwd, "ready")) ? "present" : "missing"));

  const manifest = readInstallManifest(cwd);
  if (manifest.ok) {
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

  return degraded ? 1 : 0;
}

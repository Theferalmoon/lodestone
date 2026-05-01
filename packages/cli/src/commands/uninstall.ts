// SPDX-License-Identifier: Apache-2.0
// `lodestone uninstall` stub. Body filled by §19 (uninstall correctness).
// Argv parser already accepts --dry-run per spec.
import { output } from "../ui/output.js";

export interface UninstallOptions {
  dryRun: boolean;
}

export function parseUninstallArgv(argv: readonly string[]): UninstallOptions {
  return {
    dryRun: argv.includes("--dry-run"),
  };
}

export async function uninstall(argv: readonly string[]): Promise<number> {
  parseUninstallArgv(argv);
  output.warn("`lodestone uninstall` is not yet implemented in this build (filled by §19).");
  return 0;
}

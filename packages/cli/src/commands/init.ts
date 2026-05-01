// SPDX-License-Identifier: Apache-2.0
// `lodestone init` stub. Body filled by §04 (CLI install integration).
// Argv parser already accepts --write-claude-md and --pro per spec, even
// though the stub ignores their effects, so §04 + §22 wire-up is stable.
import { output } from "../ui/output.js";

export interface InitOptions {
  writeClaudeMd: boolean;
  pro: boolean;
}

export function parseInitArgv(argv: readonly string[]): InitOptions {
  return {
    writeClaudeMd: argv.includes("--write-claude-md"),
    pro: argv.includes("--pro"),
  };
}

export async function init(argv: readonly string[]): Promise<number> {
  // Parse so flag-shape is exercised; §04 will use the result.
  parseInitArgv(argv);
  output.warn("`lodestone init` is not yet implemented in this build (filled by §04).");
  return 0;
}

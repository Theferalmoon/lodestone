// SPDX-License-Identifier: Apache-2.0
// `lodestone doctor` stub. Body filled by later sections (each adds its
// probe: §03 base shape, §05 CoreML, §18 offline-mode, §19 uninstall sanity).
import { output } from "../ui/output.js";

export async function doctor(_argv: readonly string[]): Promise<number> {
  output.warn(
    "`lodestone doctor` is not yet implemented in this build. Will probe Node version, free RAM, git, CoreML (Apple Silicon), proxy env vars, and WSL2 paths."
  );
  return 0;
}

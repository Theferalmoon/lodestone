// SPDX-License-Identifier: Apache-2.0
// Testable CLI entry. Tests import `main` and call it directly with
// argv arrays; the shebang file in bin/ is a thin wrapper that delegates here.
import { dispatch } from "./routing/dispatch.js";
import { printTopLevelHelp, printVersionLine } from "./routing/help.js";
import { output } from "./ui/output.js";

/**
 * Parse top-level flags and dispatch.
 *
 * Exit codes:
 *  - 0 — success (incl. --help / --version)
 *  - 1 — handler-emitted runtime error
 *  - 2 — usage error (unknown command / typo)
 *
 * Top-level errors thrown by handlers are caught here and converted to a
 * friendly stderr line + exit 1 — never a raw stack trace, per friend-facing
 * tone. (Set `LODESTONE_DEBUG=1` to opt into stacks; honored by future
 * sections that add a debug surface.)
 */
export async function main(argv: readonly string[]): Promise<number> {
  const [first] = argv;

  if (first === "--version" || first === "-v") {
    printVersionLine();
    return 0;
  }

  if (first === undefined || first === "--help" || first === "-h") {
    printTopLevelHelp();
    return 0;
  }

  try {
    return await dispatch(argv);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    output.error(`Internal error: ${detail}`);
    if (process.env.LODESTONE_DEBUG === "1" && err instanceof Error && err.stack) {
      output.error(err.stack);
    }
    return 1;
  }
}

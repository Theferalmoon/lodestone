// SPDX-License-Identifier: Apache-2.0
// Dispatches argv to subcommand handlers. Suggests closest match on typo
// using fastest-levenshtein. Returns the handler's exit code.
import { distance } from "fastest-levenshtein";
import { output } from "../ui/output.js";
import { SUBCOMMANDS } from "./help.js";
import { init } from "../commands/init.js";
import { status } from "../commands/status.js";
import { reindex } from "../commands/reindex.js";
import { doctor } from "../commands/doctor.js";
import { seedSkills } from "../commands/seed-skills.js";
import { upgrade } from "../commands/upgrade.js";
import { uninstall } from "../commands/uninstall.js";

type Handler = (argv: readonly string[]) => Promise<number>;

/**
 * Subcommand → handler table. Keep this in lock-step with help.ts SUBCOMMANDS;
 * the version.test runtime check enforces the two stay in sync.
 */
export const HANDLERS: Readonly<Record<string, Handler>> = Object.freeze({
  init,
  status,
  reindex,
  doctor,
  "seed-skills": seedSkills,
  upgrade,
  uninstall,
});

const KNOWN_COMMANDS: readonly string[] = Object.keys(HANDLERS);

function suggestClosest(input: string): string | null {
  let best: { name: string; d: number } | null = null;
  for (const name of KNOWN_COMMANDS) {
    const d = distance(input, name);
    if (best === null || d < best.d) {
      best = { name, d };
    }
  }
  // Only suggest when reasonably close. >3 edits and we're guessing.
  if (best && best.d <= 3) return best.name;
  return null;
}

/**
 * Dispatch `argv` (already stripped of the binary name) to the appropriate
 * handler. Returns the exit code.
 *
 * Exit codes:
 *  - 0 : success
 *  - 1 : runtime error (handler-emitted)
 *  - 2 : usage error — unknown subcommand / typo
 */
export async function dispatch(argv: readonly string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === undefined) {
    // Caller (main.ts) handles the no-command path before reaching here.
    return 2;
  }
  const handler = HANDLERS[cmd];
  if (handler !== undefined) {
    return handler(rest);
  }

  const suggestion = suggestClosest(cmd);
  output.error(`Unknown command: '${cmd}'`);
  if (suggestion !== null) {
    output.error(`Did you mean: ${suggestion}?`);
  }
  output.error("Run `lodestone --help` for the full list.");
  return 2;
}

/** Exposed for tests + help.ts symmetry check. */
export { SUBCOMMANDS };

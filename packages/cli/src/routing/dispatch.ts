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
import { planTests } from "../commands/plan-tests.js";
import { seedSkills } from "../commands/seed-skills.js";
import { upgrade } from "../commands/upgrade.js";
import { uninstall } from "../commands/uninstall.js";
import { setupModels } from "../commands/setup-models.js";
import { clientSmoke } from "../commands/client-smoke.js";

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
  "plan-tests": planTests,
  "seed-skills": seedSkills,
  upgrade,
  uninstall,
  "setup-models": setupModels,
  "client-smoke": clientSmoke,
});

const KNOWN_COMMANDS: readonly string[] = Object.keys(HANDLERS);

function suggestClosest(input: string): string | null {
  // Codex impl-003 B3: prefix matches outrank pure Levenshtein. Without this,
  // `uninst` (a clear truncation of `uninstall`) wins `init` because the
  // edit distance to `init` is shorter than to `uninstall`. That's a dangerous
  // misdirect — `init` and `uninstall` are different command families.
  // Step 1: prefer any KNOWN_COMMAND whose name starts with `input`. Among
  // ties, the shortest candidate wins (so `uninst` -> `uninstall` not a
  // hypothetical longer name).
  const prefixHits = KNOWN_COMMANDS.filter((name) =>
    name.startsWith(input) && name !== input
  ).sort((a, b) => a.length - b.length);
  if (prefixHits.length > 0 && prefixHits[0] !== undefined) {
    return prefixHits[0];
  }

  // Step 2: Levenshtein, but reject candidates much shorter than the input.
  // If the candidate is more than 50% shorter, the "match" is probably the
  // empty-prefix illusion (e.g., distance("uninst","init") = 5 because of
  // shared `in...t` letters). A length-aware threshold avoids the misdirect.
  let best: { name: string; d: number } | null = null;
  for (const name of KNOWN_COMMANDS) {
    if (name.length * 2 < input.length) continue;
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

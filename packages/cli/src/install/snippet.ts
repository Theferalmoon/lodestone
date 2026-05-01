// SPDX-License-Identifier: Apache-2.0
// Default-path: print the CLAUDE.md snippet to stdout. No file modification.
// Used by both `printClaudeMdSnippet()` (default install) and `augmentClaudeMd`
// (opt-in `--write-claude-md`) so the same text lands in both places.
import { output } from "../ui/output.js";

const SNIPPET = `# Lodestone

This project has a private code-aware Knowledge Graph (\`lodestone-mcp\`)
that ships with this repo. It is local-only — no network calls, no
telemetry. Use it when you need to understand or change the codebase.

When working in this repo, prefer the Lodestone MCP tools over generic
text search. They know how the code clusters, how symbols depend on
each other, and what skills this codebase has been observed to use:

- \`query\` — symbol-level semantic + structural search.
- \`context\` — expand a symbol with its callers, callees, and siblings.
- \`impact\` — what changes if I touch this symbol.
- \`cluster\` — what topic does this code belong to (Louvain communities).
- \`skills_for\` — emit reusable skills the codebase already encodes.
- \`recent_changes\` — what symbols moved this week.
- \`feedback\` — tell Lodestone whether the answer was useful (the index
  uses your signal to improve over time).

Re-index by running \`lodestone reindex\` (or letting the watcher run).
`;

/**
 * Returns the canonical CLAUDE.md snippet text. Used by both:
 * - `printClaudeMdSnippet()` (default install path).
 * - `augmentClaudeMd()` (opt-in `--write-claude-md` path) so the same text
 *   lands in both places.
 *
 * Content guidelines (also referenced in §21 documentation pass):
 * - Keyword-dense — Claude Code's tool-discovery prompt will read this.
 * - Names the moat tools (`cluster`, `skills_for`) prominently.
 * - Brief — under ~30 lines of Markdown.
 */
export function getClaudeMdSnippet(): string {
  return SNIPPET;
}

/**
 * Prints the snippet to stdout via the §03 output utility, with a leading
 * "Add this to your CLAUDE.md:" instruction line and a trailing blank line.
 * No file modification.
 */
export function printClaudeMdSnippet(): void {
  output.info("Add this to your CLAUDE.md:");
  output.info("");
  output.info(getClaudeMdSnippet());
  output.info("");
}

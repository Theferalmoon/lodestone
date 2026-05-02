// SPDX-License-Identifier: Apache-2.0
// Trust-boundary documentation for the v0 MCP server.
//
// === local stdio = trust the user ===
//
// The v0 Lodestone MCP server is invoked over stdio JSON-RPC. The agent
// (Claude Code, Cline, Cursor) spawns this process as a subprocess of the
// user's editor or shell. There is:
//   - no network listener
//   - no port binding
//   - no auth handshake
//   - no token validation
//
// The trust boundary is therefore "the agent ran us as a subprocess on the
// user's machine." Any process that can spawn this binary already has
// filesystem-level access to the project; nothing the MCP layer could do
// would meaningfully harden that.
//
// Future Pro mode (v0.5+) targets the docker-compose path, which adds a
// network listener and therefore needs a real auth layer. That work belongs
// in §22, not here.
//
// `assertLocalStdioTrust()` is a deliberate no-op so that callers in
// `server.ts` have a named symbol to invoke at startup. The point is to make
// the trust boundary discoverable in code (grep "local stdio = trust the user")
// not to enforce anything in v0. Removing the call would silently lose the
// boundary definition.

/**
 * Documents the v0 trust boundary as code. Always returns true. Tests grep
 * this file for the canonical phrase to prevent the boundary from being lost
 * in a refactor.
 */
export function assertLocalStdioTrust(): true {
  // local stdio = trust the user — the doc-comment grep target.
  return true;
}

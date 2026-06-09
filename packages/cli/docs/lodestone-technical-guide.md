<!-- SPDX-License-Identifier: Apache-2.0 -->

# Lodestone Technical Guide

## Standard technical documentation for the friend install

**Prepared by:** Cybersecurity Management & Network Defense, Inc.
**Document type:** Technical guide
**Version:** v0.1.6 friend-install documentation
**Date:** June 8, 2026

## System Summary

Lodestone is a project-local code intelligence sidecar for AI coding agents. It
indexes one repository, stores the index locally, and exposes read-oriented
context tools over MCP.

The v0.1.x friend install is intentionally narrow:

- One repository.
- One local `.lodestone/` directory.
- One local MCP server launched by the user's agent.
- No hosted index.
- No Lodestone account.
- No runtime source-code upload.

## Repository Layout

```text
lodestone/
  packages/
    shared/        shared types, config schema, paths, network guard
    cli/           lodestone command-line interface
    ingest/        parsing, embeddings, graph build, store, clustering
    mcp-server/    MCP tools over the local Lodestone store
  docs/            source documentation and generated docs site
  scripts/         release, install, and documentation helpers
```

## Installed Project Layout

After friend installation, a target project normally has:

```text
project/
  .mcp.json
  .gitignore
  .lodestone/
    install-manifest.json
    lodestone.toml
    lodestone.sqlite
    ready.json
    runtime/
    skills/
  node_modules/
    @lodestone/
      cli/
      ingest/
      mcp-server/
      shared/
```

The `.lodestone/` directory is local runtime data and should not be committed.

## Install Profiles

The public installer accepts `LODESTONE_PROFILE=lite` or
`LODESTONE_PROFILE=full`.

| Profile | Embedder bundled in release ingest tarball | Dimensions | Intended use |
|---|---:|---:|---|
| `lite` | `snowflake-arctic-embed-s` | 384 | Default friend install and lower-bandwidth machines. |
| `full` | `nomic-text-v1.5` | 768 | Advanced users and operator testing where the larger model is desired. |

The profile controls the release asset that is downloaded. It is separate from
the internal `[embedder].profile` config values used by `lodestone.toml`.

## Client Adapter Option

The public installer writes `.mcp.json` by default for generic MCP-aware
clients. It also accepts optional `LODESTONE_CLIENT=codex` or
`LODESTONE_CLIENT=all`; in v0.1.x, `all` keeps the default MCP surface and adds
the Codex adapter.

When enabled, `lodestone init --client codex` writes
`.codex/config.toml` with:

- `[mcp_servers.lodestone-mcp]`
- `command` pointing at `.lodestone/runtime/lodestone-mcp`
- `cwd` set to the installed project root
- `enabled = true`

This is project-local Codex configuration. Codex still controls trust: project
`.codex/config.toml` is loaded only after the project is trusted. Users should
approve the Codex trust prompt for the repo and start a new Codex session if
Codex was already open.

Validation command:

```bash
./node_modules/.bin/lodestone doctor --client codex
```

The doctor check exits non-zero when the Codex config file is missing, stale,
malformed, or points at the wrong runtime command.

Generic MCP-aware clients such as Claude Code, Cursor, Cline, and cmndclaw use
the project `.mcp.json` that Lodestone writes on every install. `lodestone init
--client mcp`, `--client cursor`, `--client cline`, `--client cmndclaw`, and
`--client claude-code` are accepted as explicit names for that default surface.
Verify the shared client surface with:

```bash
./node_modules/.bin/lodestone doctor --client mcp
```

`--client claude-code`, `--client cursor`, `--client cline`, and
`--client cmndclaw` are friendly aliases for the same `.mcp.json` check.

## Optional Claude Desktop MCPB Bundle

The repository includes a private MCPB packer for Claude Desktop:

```bash
scripts/mcpb/build-claude-desktop-bundle.mjs --profile lite
```

The bundle is for users who already installed and indexed Lodestone in the
target project. Claude Desktop asks for a `Project folder`, and the bundle
launches the bundled Lodestone MCP server with that folder as its working
directory.

MCPB artifacts are current-platform because Lodestone includes native Node
dependencies. Build separate artifacts on each target operating system family.

## Installer Flow

The friend installer at `https://lodestone.cmndi.ai/install` redirects to a
pinned raw GitHub installer ref. The script is designed to fail closed.

High-level flow:

1. Validate `LODESTONE_PROFILE`.
2. Validate optional `LODESTONE_CLIENT`.
3. Validate Node.js 20+, npm, and curl.
4. Resolve the pinned `LODESTONE_VERSION`.
5. Download four release tarballs:
   - `lodestone-shared`
   - `lodestone-mcp-server`
   - `lodestone-cli`
   - profile-specific `lodestone-ingest`
6. Verify each tarball against an embedded SHA-256 checksum.
7. Add a narrow npm root override for `protobufjs@7.5.8`, because npm
   consumer projects do not inherit the release workspace's pnpm overrides.
8. Install the tarballs into the target project's `node_modules`.
9. Run `./node_modules/.bin/lodestone init`.
10. Pass `--client codex` when `LODESTONE_CLIENT=codex` or `all` is set.
11. Leave no temporary download directory behind.

The installer does not grant repository write access. It only downloads release
artifacts.

### Strict npm override mode

Fresh installs resolve the broader advisory-sensitive transitive packages to
safe versions through normal npm resolution. Existing projects with old
lockfiles may want a stricter posture. For that case, the installer supports:

```bash
curl -sSfL https://lodestone.cmndi.ai/install | LODESTONE_STRICT_NPM_OVERRIDES=1 bash
```

Strict mode adds root overrides for `fast-uri`, `hono`, `ip-address`, and `qs`
in addition to the default `protobufjs` override. It is opt-in because these
are common packages and root overrides can affect the host project's own
dependency tree.

## Runtime Architecture

```text
source files
   |
   v
tree-sitter parsers
   |
   v
symbols and edges
   |
   v
SQLite + sqlite-vec at .lodestone/lodestone.sqlite
   |
   v
local MCP server over stdio
   |
   v
coding agent
```

The MCP server reads the local store and returns structured responses. The
coding agent remains the user interface.

## MCP Tools

| Tool | Purpose |
|---|---|
| `query` | Hybrid semantic, lexical, and graph-ranked search. |
| `context` | Definition, relationships, and metadata for a symbol. |
| `impact` | Reverse dependency and blast-radius analysis. |
| `cluster` | Architectural subsystem discovery. |
| `skills_for` | Project-specific skill guidance. |
| `recent_changes` | Git-aware changed-code context. |
| `feedback` | Local usefulness signal for prior tool calls. |
| `sql` | Optional read-only SQLite query escape hatch. Disabled by default. |

See `docs/MCP-TOOLS.md` for request and response shapes.

## Privacy and Data Handling

Lodestone's normal runtime state stays inside the target repository:

- Source code remains in the repository.
- Embeddings are stored in `.lodestone/lodestone.sqlite`.
- Graph data is stored in `.lodestone/lodestone.sqlite`.
- Skill cards are stored in `.lodestone/skills/`.
- Feedback is stored locally.

Install-time network use includes GitHub release downloads and npm dependency
resolution. Runtime model fetch is not required for the packaged `lite` and
`full` friend profiles. Future optional model setup commands are consent-gated
and routed through the Lodestone network guard; the public v0.1.x build exits
before network until real pinned hashes are published.

## Security Controls

The friend installer uses:

- Pinned release version by default.
- Embedded SHA-256 checksum verification.
- Anonymous public downloads unless maintainer auth is explicitly requested.
- Temporary download directory cleanup on success or failure.
- No `latest` resolution in the pinned public installer.

The runtime uses:

- Project-local storage.
- MCP over stdio.
- Read-only database access for MCP request paths.
- A gated `sql` tool.
- `LODESTONE_OFFLINE=1` support for blocking Lodestone-managed network calls.

## Operational Commands

Install lite:

```bash
curl -sSfL https://lodestone.cmndi.ai/install | bash
```

Install full:

```bash
curl -sSfL https://lodestone.cmndi.ai/install | LODESTONE_PROFILE=full bash
```

Install lite with Codex project config:

```bash
curl -sSfL https://lodestone.cmndi.ai/install | LODESTONE_CLIENT=codex bash
```

Install full with Codex project config:

```bash
curl -sSfL https://lodestone.cmndi.ai/install | LODESTONE_PROFILE=full LODESTONE_CLIENT=codex bash
```

Install with strict npm advisory overrides:

```bash
curl -sSfL https://lodestone.cmndi.ai/install | LODESTONE_STRICT_NPM_OVERRIDES=1 bash
```

Status:

```bash
./node_modules/.bin/lodestone status
```

Doctor, including Codex adapter validation:

```bash
./node_modules/.bin/lodestone doctor --client codex
```

Rebuild the local index:

```bash
./node_modules/.bin/lodestone reindex
```

Uninstall:

```bash
./node_modules/.bin/lodestone uninstall
```

## Upgrade Model

The public friend installer is pinned to an approved package set. Operators
move the installer forward after building, testing, checksumming, and publishing
the next release assets.

Do not point friend installs at a mutable branch for normal use.

## Current Limits

Lodestone v0.1.x does not yet provide:

- Multi-repository Pro mode.
- Hosted dashboard.
- Central admin invite system.
- Built-in usage telemetry.
- Full migration runner for every future schema change.
- GPU-specific acceleration as a supported requirement.

These limits are intentional for the friend-install phase. The priority is a
small, local, auditable install path.

## Support Checklist

When troubleshooting a friend install, collect:

- Operating system.
- Node version: `node --version`.
- npm version: `npm --version`.
- Installer command used.
- `LODESTONE_PROFILE` value, if any.
- `LODESTONE_CLIENT` value, if any.
- `LODESTONE_STRICT_NPM_OVERRIDES` value, if any.
- Last 50 lines of installer output.
- `git status --short`.
- Whether `.mcp.json` exists.
- Whether `.lodestone/install-manifest.json` exists.
- Output from `./node_modules/.bin/lodestone status`, if available.
- Output from `./node_modules/.bin/lodestone doctor --client codex`, if Codex
  setup was used.

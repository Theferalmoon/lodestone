<!-- SPDX-License-Identifier: Apache-2.0 -->

# Lodestone Friend Install

This is the simple, download-only way to add Lodestone to your own project.

You do not need write access to the Lodestone source repository. You are only
downloading an approved Lodestone release and installing it inside your own
repo.

## What This Does

The installer:

1. Downloads the approved Lodestone release files.
2. Verifies each downloaded file with SHA-256 checksums.
3. Installs Lodestone into your project's `node_modules/`.
4. Runs `lodestone init` in your project.
5. Creates local project files so your coding agent can use Lodestone.

Your code stays on your machine. Lodestone does not upload your source code.
The installer may still download normal npm package dependencies during
installation.

## Documentation

Online documentation:

```text
https://lodestone.cmndi.ai/docs/
```

If your package set includes installed docs, they are available in your project
after install at:

```text
./node_modules/@lodestone/cli/docs/
```

Start with `README.md`, then read the installation guide if you want the
plain-English walkthrough.

## Install

Run this from the project where you want Lodestone installed:

```bash
cd /path/to/your/project
git checkout -b add-lodestone
curl -sSfL https://lodestone.cmndi.ai/install | bash
```

The default install uses the `lite` profile. It is the smallest download and
the normal choice for first-time use. The installer does not ask which profile
to use; choose the command before running it.

For the larger model profile:

```bash
curl -sSfL https://lodestone.cmndi.ai/install | LODESTONE_PROFILE=full bash
```

For Codex CLI or the Codex IDE extension, add the optional Codex adapter:

```bash
curl -sSfL https://lodestone.cmndi.ai/install | LODESTONE_CLIENT=codex bash
```

That writes `.codex/config.toml` for this project. Codex still requires the
project to be trusted before it loads project-local config. Approve the Codex
trust prompt for this repo, then start a new Codex session if Codex was already
open.

## What Access You Get

You get a local installed copy of Lodestone inside your own project.

You do not get permission to push changes to the official Lodestone repository.
Only approved maintainers can change the canonical Lodestone source and release
process.

## After Install

Open your MCP-aware coding agent in the same project directory and ask:

```text
what are the main subsystems of this codebase?
```

The agent should use Lodestone to inspect the local project index.

For Codex, verify the project adapter first:

```bash
./node_modules/.bin/lodestone doctor --client codex
```

If Codex still does not list Lodestone tools, collect a support smoke report:

```bash
./node_modules/.bin/lodestone client-smoke --client codex
```

That command does not run Codex or edit global Codex settings. It validates the
project-local Codex config, checks the local Lodestone MCP launcher, and prints
exact Codex commands a maintainer can run in a trusted smoke repo.

For Claude Code, collect the shared MCP support smoke report:

```bash
./node_modules/.bin/lodestone client-smoke --client claude-code
```

That command does not run Claude Code or edit global Claude settings. It
validates `.mcp.json`, checks the local Lodestone MCP launcher, and prints exact
Claude Code commands for a trusted smoke repo.

## Files Created Locally

Lodestone creates project-local files such as:

- `.lodestone/`
- `.mcp.json`
- optional `.codex/config.toml` when `LODESTONE_CLIENT=codex` is used
- entries in `.gitignore`

The `.lodestone/` directory is local cache and index data. Do not commit it.

## Updating Later

The operator controls the approved installer and release. Use the same command
again when told to upgrade:

```bash
curl -sSfL https://lodestone.cmndi.ai/install | bash
```

## Removing Lodestone

From the same project directory:

```bash
./node_modules/.bin/lodestone uninstall
```

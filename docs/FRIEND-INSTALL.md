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

## Install

Run this from the project where you want Lodestone installed:

```bash
cd /path/to/your/project
git checkout -b add-lodestone
curl -sSfL https://lodestone.cmndi.ai/install | bash
```

The default install uses the `lite` profile. It is the smallest download and
the normal choice for first-time use.

For the larger model profile:

```bash
curl -sSfL https://lodestone.cmndi.ai/install | LODESTONE_PROFILE=full bash
```

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

## Files Created Locally

Lodestone creates project-local files such as:

- `.lodestone/`
- `.mcp.json`
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

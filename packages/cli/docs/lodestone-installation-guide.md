<!-- SPDX-License-Identifier: Apache-2.0 -->

# Lodestone Installation Guide

## Plain-English friend install instructions

**Prepared by:** Cybersecurity Management & Network Defense, Inc.
**Document type:** Installation guide
**Version:** v0.1.11 friend-install documentation
**Date:** June 13, 2026

## What You Are Installing

Lodestone is a local helper for AI coding agents. It reads your project,
builds a local code map, and lets your coding agent ask better questions about
the project.

It installs into your own project folder. It does not give you permission to
change the official Lodestone source repository.

## Before You Start

You need:

- A project or repository where you want to use Lodestone.
- A terminal opened in that project folder.
- Node.js 20 or newer.
- npm.
- curl.
- Internet access during installation.
- An MCP-aware coding agent, such as Claude Code or another editor/agent that
  reads `.mcp.json`.

You do not need:

- Write access to the official Lodestone repository.
- A Lodestone account.
- A cloud index.
- A GPU.

If you use Codex CLI or the Codex IDE extension, you can add the Codex adapter during
install. Codex will still ask you to trust the project before it loads
project-local config.

## Safety Step: Use a New Branch

Before installing any tool into a project, use a new branch. This makes it easy
to see what changed and undo the install if you do not want to keep it.

```bash
cd /path/to/your/project
git checkout -b add-lodestone
```

If your project does not use Git, you can still install Lodestone, but using Git
is strongly recommended.

## Option 1: Lite Install

This is the recommended first install.

The installer does not ask you to choose a profile while it runs. Pick one of
the two commands below before you start. If you are not sure, use `lite`.

Use this if:

- You are trying Lodestone for the first time.
- You are on a laptop.
- You have limited bandwidth.
- You want the smallest Lodestone download.

Run this from your project folder:

```bash
curl -sSfL https://lodestone.cmndi.ai/install | bash
```

What this downloads:

- The approved Lodestone v0.1.11 package set.
- The `lite` ingest package with the Snowflake 384-dimensional embedder.
- About 16 MB of Lodestone release tarballs.

Important disk note:

After npm installs all normal Node dependencies, the full `node_modules` folder
can be about 1 GB in either profile. That is mostly normal dependency size, not
the Lodestone model itself.

## Option 2: Full Install

Use this if:

- You want the larger embedder.
- You have a stronger machine.
- You have enough bandwidth and disk space.
- A CMNDI operator told you to use the full profile.

Run this from your project folder:

```bash
curl -sSfL https://lodestone.cmndi.ai/install | LODESTONE_PROFILE=full bash
```

What this downloads:

- The approved Lodestone v0.1.11 package set.
- The `full` ingest package with the Nomic 768-dimensional embedder.
- About 89 MB of Lodestone release tarballs.

The full profile is not required for a successful first test. If you are not
sure which one to choose, use `lite`.

## Optional: Codex Adapter

Use this if your coding agent is Codex CLI or the Codex IDE extension.

Run the installer with the Codex adapter:

```bash
curl -sSfL https://lodestone.cmndi.ai/install | LODESTONE_CLIENT=codex bash
```

This still uses the default `lite` profile. For full plus Codex:

```bash
curl -sSfL https://lodestone.cmndi.ai/install | LODESTONE_PROFILE=full LODESTONE_CLIENT=codex bash
```

What this adds:

- `.codex/config.toml`
- a `lodestone-mcp` MCP server entry for this project

After install, approve the Codex trust prompt for this repo. If Codex was
already open, start a new Codex session.

To add Codex later after a normal install:

```bash
./node_modules/.bin/lodestone init --client codex --no-reindex
```

To verify Codex setup:

```bash
./node_modules/.bin/lodestone doctor --client codex
```

If Codex still does not list Lodestone tools, collect the support smoke command:

```bash
./node_modules/.bin/lodestone client-smoke --client codex
```

This command does not run Codex and does not edit global Codex settings. It
checks `.codex/config.toml`, checks that the local Lodestone MCP launcher
exists and is executable, and prints exact Codex commands for a trusted smoke
repo.

For Claude Code, Cursor, Cline, cmndclaw, and other clients that use the
project `.mcp.json`, no extra installer option is required. Verify that shared
MCP config with:

```bash
./node_modules/.bin/lodestone doctor --client mcp
```

You can also use the matching client name, such as:

```bash
./node_modules/.bin/lodestone doctor --client cursor
```

### Claude Desktop MCPB Option

Claude Desktop users who prefer a one-click extension can use a private
current-platform MCPB bundle after Lodestone has already been installed and
indexed in the target project. See `docs/MCPB.md` or the online docs page for
the bundle build and install steps.

## What the Installer Does

The installer:

1. Downloads the approved Lodestone release files from GitHub.
2. Verifies each file with a SHA-256 checksum.
3. Installs Lodestone into your project's `node_modules` folder.
4. Runs `lodestone init` in your project.
5. Writes `.mcp.json` so your coding agent can find the Lodestone MCP server.
6. Optionally writes `.codex/config.toml` when `LODESTONE_CLIENT=codex` is set.
7. Creates `.lodestone/` for the local index, cache, and manifest.
8. Runs the first indexing pass.

Advanced operators can set `LODESTONE_STRICT_NPM_OVERRIDES=1` when installing
into an existing project with an old lockfile. Do not use that option unless
you specifically want Lodestone to add stricter root dependency overrides to
the project.

## What Files Are Created

Typical new or changed files:

| Path | What it is | Commit it? |
|---|---|---|
| `.mcp.json` | Lets your MCP-aware agent start Lodestone. | Usually yes, after reviewing. |
| `.codex/config.toml` | Optional Codex project MCP config. Created only for Codex setup. | Usually yes, after reviewing. |
| `.gitignore` | Adds `.lodestone/` so local index data is not committed. | Usually yes. |
| `.lodestone/` | Local index, cache, manifest, runtime files. | No. |
| `node_modules/` | npm dependencies installed into the project. | No. |

Lodestone tries to preserve your existing files. If `.mcp.json`, `.gitignore`,
or `CLAUDE.md` already exists, Lodestone updates them conservatively.

## After Install

Open your coding agent in the same project folder and ask:

```text
what are the main subsystems of this codebase?
```

Good follow-up questions:

```text
where should I change the login flow?
```

```text
what depends on packages/api/src/auth.ts?
```

```text
what changed recently on this branch?
```

```text
what project-specific patterns should I follow before editing tests?
```

## Where to Find the Documentation

Online HTML documentation:

```text
https://lodestone.cmndi.ai/docs/
```

If your installed package set includes docs, local documentation is here:

```text
./node_modules/@lodestone/cli/docs/
```

In the Lodestone source repository, documentation is here:

```text
docs/friend/
docs/site/
docs/README.md
```

## How to Confirm It Worked

From your project folder:

```bash
./node_modules/.bin/lodestone status
```

You can also check that these exist:

```bash
test -f .mcp.json && echo "MCP config exists"
test -d .lodestone && echo "Local Lodestone folder exists"
```

Then ask the coding agent the subsystem question above.

If you use Codex, also run:

```bash
./node_modules/.bin/lodestone doctor --client codex
```

## Updating Later

Use the same installer command when CMNDI tells you there is an approved update:

```bash
curl -sSfL https://lodestone.cmndi.ai/install | bash
```

The public installer is pinned to an approved package set. It is intentionally
not a moving `latest` installer.

## Removing Lodestone

From the same project folder:

```bash
./node_modules/.bin/lodestone uninstall
```

Then review the branch diff:

```bash
git status
git diff
```

If you installed on a branch and do not want to keep anything, you can delete
the branch using your normal Git workflow.

## Troubleshooting

### "node is required"

Install Node.js 20 or newer, then run the installer again.

### "npm is required"

Install npm. It normally comes with Node.js.

### "invalid LODESTONE_PROFILE"

Only these values are supported:

```text
lite
full
```

### "checksum mismatch"

Stop. Do not force the install. The downloaded file did not match the checksum
embedded in the installer.

### "Reindex failed"

The install side effects may still be present. Try:

```bash
./node_modules/.bin/lodestone reindex
```

If that fails, send the error message to the CMNDI operator who gave you the
installer.

### "My agent does not see Lodestone"

Make sure:

- You opened the agent in the same project folder.
- `.mcp.json` exists in that folder.
- Your agent supports MCP.
- You restarted the agent after install.

## Best First Test

The simplest useful test is:

1. Install the `lite` profile.
2. Open your coding agent in the project.
3. Ask: `what are the main subsystems of this codebase?`
4. Ask: `what would be impacted if I changed <file or function>?`
5. Review whether the answer points to real files and relationships.

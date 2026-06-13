<!-- SPDX-License-Identifier: Apache-2.0 -->

# Lodestone

## Local code intelligence for AI coding agents

**Prepared by:** Cybersecurity Management & Network Defense, Inc.
**Document type:** Feature brochure
**Version:** v0.1.14 friend-install documentation
**Date:** June 13, 2026

## Executive Overview

Lodestone gives an AI coding agent a local map of a software project before the
agent starts making changes. It builds a project-local knowledge graph from the
repository, stores it on the user's machine, and exposes it through Model
Context Protocol (MCP) tools that coding agents can call when they need to
understand the code.

The practical result is simple: the agent is less dependent on guessing from a
single open file. It can ask Lodestone where a symbol lives, what depends on it,
what recently changed, which subsystems exist, and what project-specific coding
patterns matter.

Lodestone is designed for people who want useful AI coding help without sending
their source code to a remote indexing service.

## The Problem

Most AI coding tools are strong at editing the file in front of them, but weak
at understanding the whole project. That creates predictable failures:

- The agent changes one file and misses the caller, test, config, or generated
  surface that depends on it.
- New agents spend time rediscovering the same project structure over and over.
- Complex repositories overwhelm new users because the next step is not obvious.
- Hosted indexing products may require code upload, account setup, or a new
  cloud dependency.
- Teams with privacy, compliance, or client restrictions cannot casually send
  repository data to a third-party index.

Lodestone is built to make local context available before those failures happen.

## What Lodestone Does

Lodestone installs inside the user's own repository. It parses source files,
builds a symbol graph, creates local embeddings, clusters related code into
subsystems, and writes everything under `.lodestone/` in that project.

The coding agent talks to Lodestone through MCP. The user does not need to learn
a complicated dashboard first. They can ask natural questions like:

```text
what are the main subsystems of this codebase?
```

or:

```text
what will break if I change this function?
```

## Full Feature Set

### Local project knowledge graph

Lodestone records symbols, files, relationships, callers, callees, class
inheritance, PageRank scores, clusters, and embedding vectors in a local SQLite
database.

### Hybrid code search

The `query` tool combines semantic search, lexical matching, and graph ranking
so an agent can find code by meaning, name, path, or architectural importance.

### Symbol context

The `context` tool gives a 360-degree view of one symbol: definition, source
location, cluster membership, callers, callees, and surrounding metadata.

### Impact analysis

The `impact` tool answers the question that matters before an edit: "what else
depends on this?" It uses reverse dependency traversal over the local graph.

### Recent changes

The `recent_changes` tool lets the agent ask what changed recently without
blindly scanning the repo or relying on a human to summarize the branch. This
is git-aware current-index context, not a historical temporal graph.

### Architectural clustering

The `cluster` tool groups related code into emergent subsystems. This helps new
users and new agents quickly understand the shape of a repository.

### Project-specific skill cards

The `skills_for` tool returns local SKILL.md guidance based on the patterns in
the project, such as testing idioms, error-handling style, and naming
conventions.

### Local feedback loop

The `feedback` tool records whether a previous Lodestone-assisted answer was
useful. The data stays local and can later support better project-specific
guidance.

### Optional read-only SQL

The `sql` tool is a gated advanced feature. When explicitly enabled, it allows
read-only SQLite queries against the local index for power users and debugging.

### Two friend install profiles

The installer supports two download profiles:

| Profile | Best for | Bundled embedder | Release download size |
|---|---|---|---|
| `lite` | First-time users, laptops, low bandwidth | Snowflake Arctic Embed S, 384 dimensions | About 16 MB |
| `full` | Advanced users who want the larger model | Nomic Embed Text v1.5, 768 dimensions | About 89 MB |

Both profiles keep source code local. The difference is the model packaged into
the ingest tarball.

### Optional Codex adapter

Lodestone can write project-local Codex MCP configuration during install. A
Codex user adds `LODESTONE_CLIENT=codex` to the installer command, then verifies
with `lodestone doctor --client codex`. Codex still decides whether the project
is trusted before loading `.codex/config.toml`. If support needs a reproducible
Codex check, `lodestone client-smoke --client codex` validates the generated
config and local MCP launcher, then prints exact Codex smoke commands.
For generic MCP support, `lodestone client-smoke --client mcp` launches the
repo-local Lodestone server over stdio and verifies that it returns a tool list,
without claiming any specific editor has loaded the config.

## Why Lodestone Is Better Than Common Alternatives

| Common approach | Typical issue | Lodestone difference |
|---|---|---|
| Ask the AI agent to inspect files manually | Slow, inconsistent, easy to miss dependencies | The agent gets structured MCP tools over a persistent local index. |
| Hosted code indexing service | May require source upload, account setup, and vendor trust | Lodestone stores the graph, embeddings, and feedback under `.lodestone/` locally. |
| Editor-only workspace search | Usually lexical and file-oriented | Lodestone adds symbols, graph relationships, embeddings, clusters, and impact analysis. |
| A large dashboard | Can overwhelm new users before they know what to click | Lodestone's first interaction can be one plain question in the coding agent. |
| Generic coding rules | Do not adapt to the specific repo | Lodestone emits project-specific skill guidance from the codebase. |
| Manual onboarding docs | Drift as code changes | Lodestone can be rebuilt from the current repository state. |

## Design Principles

### Local first

The local repository remains the boundary. Lodestone is a sidecar for the
project, not a remote service that owns the project context.

### Agent native

Lodestone is exposed through MCP because coding agents already know how to call
MCP tools. The default `.mcp.json` path works for common MCP-aware editors, and
the optional Codex adapter writes Codex's project-local MCP config. The user
should not have to copy and paste large context packets.

### Beginner friendly

The install path is intentionally simple. The default path is the `lite` profile
and the first recommended question is obvious.

### Power user capable

Advanced users can choose the `full` profile, enable read-only SQL, inspect the
SQLite database, and operate Lodestone from the CLI.

### Honest about limits

Lodestone v0.1.x is a one-repository friend install. Pro mode, multi-repo
operation, temporal KG history, migration automation, and heavier enterprise
orchestration are v0.5+ or later work.

## Who Should Use It

Lodestone is a strong fit for:

- A friend or partner testing AI coding in their own repo.
- A solo engineer who wants an agent to understand the project faster.
- A team with privacy restrictions that cannot upload code to a hosted index.
- A regulated or public-sector team that wants local tooling first.
- A CMNDI operator dogfooding agentic coding workflows.

## What Success Looks Like

After install, the user opens their MCP-aware coding agent in the project and
asks:

```text
what are the main subsystems of this codebase?
```

A good first result names the major areas of the project and points to the code
that supports those names. From there, the user can ask where to make a change,
what depends on a file, or what changed on the branch.

## One Sentence

Lodestone gives an AI coding agent a private, local, structured understanding of
the repository before it starts editing.

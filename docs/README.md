<!-- SPDX-License-Identifier: Apache-2.0 -->

# Lodestone

A project-local, code-aware Knowledge Graph for coding agents. Lodestone watches one repository, parses every source file with tree-sitter, builds a symbol-and-call graph, embeds each symbol locally with a bundled ONNX model, clusters the graph into emergent architectural modules, emits SKILL.md cards for the patterns it sees, and exposes the whole thing to your editor's coding agent over MCP. It's for engineers who want their AI assistant to actually understand the codebase it's editing — not just read the file in front of it.

**Your code never leaves your machine.** Embeddings, the call graph, cluster names, skill cards, feedback events — everything is written to `.lodestone/` inside your project, locally. There is no telemetry, no upload step, and no remote service to call. See [`PRIVACY.md`](./PRIVACY.md) for the implementation details and the build-time grep audit that enforces it.

## Install

```bash
npx lodestone init
```

That command does the magic-moment work: detects your project's languages, writes `.lodestone/lodestone.toml`, scaffolds the SQLite + sqlite-vec store, downloads zero models on the default profile (the embedder is bundled), runs the first ingest pass, and writes a `.mcp.json` snippet your coding agent can pick up. Then open Claude Code (or Cursor, or any other MCP-aware client) in the same directory and ask:

> *what are the main subsystems of this codebase?*

The agent will call `cluster()` and read back the Louvain communities Lodestone discovered. That's the moment that justifies the install.

## What you get

Eight MCP tools, all returning a uniform `LodestoneToolResponse<T>` envelope with `request_id`, `provenance`, and `diagnostics` so the agent always knows how stale the data is:

- **`query(question, top_k=10, filters?)`** — hybrid semantic + lexical + PageRank-weighted search across symbols.
- **`recent_changes(since?, top_k=20)`** — git-aware "what just changed" without shelling out to git on the request path.
- **`context(symbol)`** — the 360 view of one symbol: definition, callers, callees, the cluster it belongs to.
- **`impact(file_or_symbol)`** — reverse blast-radius via a recursive CTE on the edges table. Run before you edit.
- **`cluster(name_or_query, granularity?)`** — the moat. Surfaces emergent architectural modules with naming evidence.
- **`skills_for(task_description, top_k=5)`** — emerging moat. Returns codebase-specific SKILL.md cards (error-handling style, test idioms, naming conventions). Best results after the index has watched the repo for ≥7 days; fresh installs get seed skills.
- **`feedback(tool, request_id, signal, note?)`** — the single write tool. Agent thumbs-up / thumbs-down on prior calls feeds the training signal.
- **`sql(query)`** — gated escape hatch. Read-only SQLite queries against the project index. Only registered when `[mcp].dangerous_tools_enabled = true`. Use for ad-hoc graph traversals beyond the canned tools.

Full reference (request shapes, response shapes, examples): [`MCP-TOOLS.md`](./MCP-TOOLS.md).

## The first 60 seconds

```bash
$ cd ~/code/your-project
$ npx lodestone init
[lodestone] detected languages: typescript, javascript
[lodestone] wrote .lodestone/lodestone.toml
[lodestone] bootstrapping SQLite + sqlite-vec store ...
[lodestone] first ingest: 1247 files, 8932 symbols, 14217 edges (12.4s)
[lodestone] wrote .mcp.json snippet — restart your MCP-aware editor to pick it up
[lodestone] done. Run `lodestone status` for index health.
```

Open Claude Code (or any MCP client) in the same directory. Ask: *what are the main subsystems of this codebase?* The agent should call `cluster()` and read back the Louvain communities.

## Where to go next

| Doc | What's in it |
|---|---|
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | Stack choices (Node-only, Louvain not Leiden, SQLite + sqlite-vec, KuzuDB deferred), the `packages/*` monorepo layout, friend-mode vs Pro-mode. |
| [`CONFIG.md`](./CONFIG.md) | Every key in `lodestone.toml` with its type, default, allowed values, and one-line explanation. Plus environment variable overrides. |
| [`MCP-TOOLS.md`](./MCP-TOOLS.md) | The 8 MCP tools — request shapes, response shapes, JSON examples, when to use each. |
| [`PRIVACY.md`](./PRIVACY.md) | The "never leaves your machine" claim, what it actually means, and the build-time enforcement. |
| [`SUPPLY-CHAIN.md`](./SUPPLY-CHAIN.md) | Why these specific models and libraries — license, origin, audit posture. |
| [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) | WSL2 paths, corp proxies, Apple Silicon, missing prebuilds, parse failures, big repos. |
| [`UPGRADE.md`](./UPGRADE.md) | How to upgrade the CLI, schema-version expectations, and the v0 → v0.5 migration path. |
| [`DEMO-REPO.md`](./DEMO-REPO.md) | The synthetic demo repo at `e2e/synthetic-demo-repo/`, why it exists, and how to use it as a teaching example. |

## Status

Lodestone v0.1.0 is the first ship. Sections §01 through §20 of the implementation plan are landed and tested (790 unit + e2e tests). Pro mode (multi-repo / shared index) is deferred to v0.5+; the `lodestone init --pro` flag returns a clear "v0.5+ work" message and exits cleanly.

## License

Apache-2.0. See [`../LICENSE`](../LICENSE), [`../NOTICE`](../NOTICE), and [`../LICENSE-AUTHORIZATION.md`](../LICENSE-AUTHORIZATION.md).

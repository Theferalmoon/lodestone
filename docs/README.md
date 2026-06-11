<!-- SPDX-License-Identifier: Apache-2.0 -->

# Lodestone

A project-local, code-aware Knowledge Graph for coding agents. Lodestone watches one repository, parses every source file with tree-sitter, builds a symbol-and-call graph, embeds each symbol locally with a bundled ONNX model, clusters the graph into emergent architectural modules, emits SKILL.md cards for the patterns it sees, and exposes the whole thing to your editor's coding agent over MCP. It's for engineers who want their AI assistant to actually understand the codebase it's editing — not just read the file in front of it.

**Your code never leaves your machine.** Embeddings, the call graph, cluster names, skill cards, feedback events — everything is written to `.lodestone/` inside your project, locally. There is no telemetry, no upload step, and no remote service to call. See [`PRIVACY.md`](./PRIVACY.md) for the implementation details and the build-time grep audit that enforces it.

> **Note (v0.1.9).** The `npx lodestone init` flow described below is the
> v0.5+ npm-publish path and is **not yet wired** — `@lodestone/cli` is not
> on the npm registry. Today's working install is the curl-bash one-liner
> from the [top-level README](../README.md#install-one-liner):
>
> ```bash
> curl -sSfL https://lodestone.cmndi.ai/install | bash
> ```
>
> That command downloads the approved release tarballs, verifies their SHA-256
> checksums, installs Lodestone into the current project, and runs
> `lodestone init`. See [`FRIEND-INSTALL.md`](./FRIEND-INSTALL.md) for the
> plain-English download-only handoff.

## Install

```bash
# v0.5+ (not yet wired):
npx lodestone init

# Today (download-only friend install):
curl -sSfL https://lodestone.cmndi.ai/install | bash
```

Either command does the magic-moment work: detects your project's languages, writes `.lodestone/lodestone.toml`, scaffolds the SQLite + sqlite-vec store, downloads zero models on the default profile (the embedder is bundled), runs the first ingest pass, and writes a `.mcp.json` snippet your coding agent can pick up.

If you use Codex, add `LODESTONE_CLIENT=codex` to the installer command or run `lodestone init --client codex --no-reindex` after install. This writes a project-local `.codex/config.toml` MCP entry. Codex loads that file only after the project is trusted; approve the trust prompt, then start a new Codex session if Codex was already open.

Then open Claude Code, Codex, Cursor, or any other MCP-aware client in the same directory and ask:

> *what are the main subsystems of this codebase?*

The agent will call `cluster()` and read back the Louvain communities Lodestone discovered. That's the moment that justifies the install.

For Claude Code, Cursor, Cline, cmndclaw, and other clients that read the
project `.mcp.json`, verify the shared MCP config with:

```bash
./node_modules/.bin/lodestone doctor --client mcp
```

The friendly aliases `--client claude-code`, `--client cursor`,
`--client cline`, and `--client cmndclaw` run that same check.

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
$ curl -sSfL https://lodestone.cmndi.ai/install | bash
[lodestone-install] profile = lite
[lodestone-install] latest = v0.1.9
[lodestone-install] downloading tarballs ... (4 files, ~16 MB)
[lodestone-install] installing into ./node_modules ...
[lodestone-install] running 'lodestone init' ...
[ok] Lodestone install complete.
  .mcp.json:        created
  install manifest: .lodestone/install-manifest.json
[ok] Reindex complete.
  files parsed:        1247
  symbols indexed:     8932
  edges (resolved):    14217
  embeddings:          8932
```

Open Claude Code (or any MCP client) in the same directory. Ask: *what are the main subsystems of this codebase?* The agent should call `cluster()` and read back the Louvain communities.

## Where to go next

| Doc | What's in it |
|---|---|
| [`friend/lodestone-feature-brochure.md`](./friend/lodestone-feature-brochure.md) | Friend-facing feature brochure, differentiators, use cases, and honest limits. |
| [`friend/lodestone-installation-guide.md`](./friend/lodestone-installation-guide.md) | Layperson install guide for the two supported install options: `lite` and `full`. |
| [`friend/lodestone-technical-guide.md`](./friend/lodestone-technical-guide.md) | Standard technical documentation for the friend install, package layout, privacy, operations, and support checklist. |
| [`site/index.html`](./site/index.html) | Generated HTML copy of the documentation published at `https://lodestone.cmndi.ai/docs/`. |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | Stack choices (Node-only, Louvain not Leiden, SQLite + sqlite-vec, KuzuDB deferred), the `packages/*` monorepo layout, friend-mode vs Pro-mode. |
| [`CONFIG.md`](./CONFIG.md) | Every key in `lodestone.toml` with its type, default, allowed values, and one-line explanation. Plus environment variable overrides. |
| [`ROADMAP.md`](./ROADMAP.md) | Friend-distribution boundaries and Pro-only temporal KG direction. |
| [`MCP-TOOLS.md`](./MCP-TOOLS.md) | The 8 MCP tools — request shapes, response shapes, JSON examples, when to use each. |
| [`MCPB.md`](./MCPB.md) | Private Claude Desktop MCPB bundle build and install path. |
| [`PRIVACY.md`](./PRIVACY.md) | The "never leaves your machine" claim, what it actually means, and the build-time enforcement. |
| [`SUPPLY-CHAIN.md`](./SUPPLY-CHAIN.md) | Why these specific models and libraries — license, origin, audit posture. |
| [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) | WSL2 paths, corp proxies, Apple Silicon, missing prebuilds, parse failures, big repos. |
| [`UPGRADE.md`](./UPGRADE.md) | How to upgrade the CLI, schema-version expectations, and the v0 → v0.5 migration path. |
| [`DEMO-REPO.md`](./DEMO-REPO.md) | The synthetic demo repo at `e2e/synthetic-demo-repo/`, why it exists, and how to use it as a teaching example. |

## Generated Docs Policy

The generated docs under `docs/site/`, `docs/friend/word/`, and
`packages/cli/docs/` are intentionally tracked. They are distribution
artifacts: `docs/site/` is what gets published at
`https://lodestone.cmndi.ai/docs/`, and `packages/cli/docs/` is copied into the
friend install package so the installer can point users at local documentation.

Release packaging sets stable docs metadata from the release commit before
packing. For manual rebuilds that need byte-for-byte stable output, set either
`SOURCE_DATE_EPOCH` or `LODESTONE_DOCS_BUILD_TIMESTAMP` before running:

```bash
SOURCE_DATE_EPOCH="$(git log -1 --format=%ct HEAD)" pnpm docs:friend
```

Do not add these generated docs directories to `.gitignore` unless the
distribution model changes.

## Status

Lodestone v0.1.0 is the first ship. Sections §01 through §20 of the implementation plan are landed and tested (790 unit + e2e tests). Pro mode (multi-repo / shared index) is deferred to v0.5+; the `lodestone init --pro` flag returns a clear "v0.5+ work" message and exits cleanly.

## License

Apache-2.0. See [`../LICENSE`](../LICENSE), [`../NOTICE`](../NOTICE), and [`../LICENSE-AUTHORIZATION.md`](../LICENSE-AUTHORIZATION.md).

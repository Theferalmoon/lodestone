<!-- SPDX-License-Identifier: Apache-2.0 -->

# Architecture

Lodestone v0 is a single-process, project-local Knowledge Graph that lives entirely inside `.lodestone/` in the repository it indexes. This document covers the locked v0 stack choices and the repo layout. For configuration keys, see [`CONFIG.md`](./CONFIG.md). For the MCP surface, see [`MCP-TOOLS.md`](./MCP-TOOLS.md).

## Locked v0 decisions

### Node-only runtime

The CLI, the ingest pipeline, the embedder, the storage layer, the clusterer, the skill emitter, and the MCP server are all TypeScript on Node 20+. There is no Python sidecar, no Go agent, no helper service. One `npm install` (or `npx`) gets a friend running.

Why: friends already have Node. Adding a Python venv or a system-package install would lose half the audience before the first `init`. The cost is that we do not have access to the richer Python ML ecosystem at runtime — but we do not need it. Embedding inference happens in `transformers.js` (ONNX Runtime under the hood) and the rest of the pipeline is pure data movement.

### Tree-sitter for parsing, all five v0 languages

`web-tree-sitter` (WASM) is the parser. v0 supports:

- TypeScript / TSX
- JavaScript / JSX
- Python
- Go
- Rust

Adding a language is a matter of dropping in the language's WASM grammar and writing a small extractor over the parse tree. We chose tree-sitter because it gives us the same AST shape across languages with the same library — important for the cross-language graph builder in `@lodestone/ingest/graph`.

### Embedder: bundled ONNX, no fetch on the default profile

The default embedder profile bundles `nomic-embed-text-v1.5` (ONNX int8, ~150 MB) inside `@lodestone/ingest`. No network call is required to embed. A `tiny` profile uses a smaller fallback (`snowflake-arctic-embed-s`) which is fetched on first use **only when** `LODESTONE_OFFLINE=1` is not set; once cached it is reused. A `pro` profile is reserved for v0.5+.

Why bundled: the privacy claim ("your code never leaves your machine") only holds if the default install does not phone home. We accept the install size cost.

### Storage: SQLite (better-sqlite3 + WAL) + sqlite-vec

All persisted state — symbols, edges, PageRank scores, class inheritance, clusters, cluster members, skill rows, embeddings, feedback events, `ready.json` — lives in a single SQLite database under `.lodestone/store/lodestone.db`. The `sqlite-vec` extension provides the `symbol_embeddings` virtual table for vector ANN. WAL mode is on. Foreign keys are enforced. The reader handle is opened in `readonly` mode at the driver layer so MCP tools cannot accidentally write.

Why SQLite over LanceDB + KuzuDB: the original plan was LanceDB for vectors and KuzuDB for the graph. After the §08 implementation pass we collapsed both into SQLite + sqlite-vec because (a) the graph queries Lodestone actually runs (callers, callees, recursive impact) are well-served by recursive CTEs over an `edges` table, and (b) keeping one process, one file, and one transaction model dramatically simplified the surface for friends installing on macOS, Linux, and WSL2.

### Clustering: Louvain, not Leiden, in v0

`graphology` + `graphology-communities-louvain`. Modularity-maximizing community detection. Run on the symbol-and-call graph weighted by a configurable mix of call frequency, file co-location, and PageRank.

Why Louvain in v0: it has a maintained Node implementation with predictable runtime on graphs up to ~50k symbols (the v0 friend-repo target). Leiden gives marginally better community quality but the available Node bindings are less stable. Leiden is on the Pro-mode roadmap.

### MCP surface, eight tools

The MCP server is built on `@modelcontextprotocol/sdk` and runs locally over stdio. Eight tools, all returning a uniform `LodestoneToolResponse<T>` envelope. The `sql` tool (read-only SQLite escape hatch) is gated behind `[mcp].dangerous_tools_enabled` because exposing arbitrary read access to the index is a power-user feature, not a default.

See [`MCP-TOOLS.md`](./MCP-TOOLS.md) for per-tool contracts.

### Friend mode vs Pro mode

v0 ships **friend mode**: one repository, one local index, one MCP server. Pro mode (multiple repositories sharing a Docker-Compose-orchestrated index, multi-user feedback aggregation, periodic re-clustering jobs) is deferred to v0.5+. The `lodestone init --pro` flag is wired to print a clear "Pro mode is v0.5+ work" exit message and not crash, so forward-looking config files do not break.

## Repo layout

```
lodestone/
├── packages/
│   ├── shared/        # Types, schemas, envelope, paths, net chokepoint
│   ├── cli/           # `lodestone` binary + commands
│   ├── ingest/        # Embedder + parsers + graph + store + clusterer + skill emitter + watcher
│   └── mcp-server/    # @lodestone/mcp-server — the 8 MCP tools
├── e2e/               # End-to-end harness: orchestrator, network interceptor, synthetic demo repo
├── docs/              # This directory
├── package.json       # pnpm workspace root
├── pnpm-workspace.yaml
└── pnpm-lock.yaml
```

### Per-package responsibilities

- **`@lodestone/shared`** — zero-runtime-dependency type and schema package. Owns `LodestoneToolResponse<T>`, `Provenance`, `Diagnostics`, the `lodestone.toml` zod schema, `LodestoneSymbol` / `Edge` / `Cluster` types, the SQLite schema (canonical row types), and the network chokepoint (`assertNetworkAllowed`, `LODESTONE_OFFLINE` enforcement). Every other package imports types from here.
- **`@lodestone/cli`** — the user-facing binary. Owns `init`, `status`, `reindex`, `doctor`, `seed-skills`, `upgrade`, and `uninstall`. Routes subcommands; renders progress bars; loads `lodestone.toml`; orchestrates ingest pipeline calls.
- **`@lodestone/ingest`** — the heavy package. Subpath exports for `embed`, `parsers`, `graph`, `store`, `clusterer`, `skill-emitter`, `seed-skills`, and `watcher`. Each subsystem is independently testable. The MCP server reads from this package's `store` subpath via the `openReader` handle.
- **`@lodestone/mcp-server`** — the MCP protocol surface. Owns the eight tool implementations, the response envelope wrapper, the in-flight cap, the response-size truncator, and the local-stdio trust assertion. Boots via `createServer()`.

## Data flow

```
   ┌─────────┐   parse    ┌──────────┐   build    ┌────────┐
   │  files  │ ─────────▶ │  ASTs    │ ─────────▶ │ graph  │
   └─────────┘ tree-sitter└──────────┘ §07 graph  └────────┘
                                                       │
                                       PageRank +      │
                                       resolve edges   ▼
                                                  ┌────────────┐
                                                  │ SQLite +   │
                              embed (bundled)  ─▶ │ sqlite-vec │
                                                  └────────────┘
                                                       │
                                       cluster (Louvain)
                                                       ▼
                                                  ┌────────────┐
                                                  │  clusters  │
                                                  └────────────┘
                                                       │
                                       skill emitter   ▼
                                                  ┌────────────┐
                                                  │ SKILL.md   │
                                                  │   cards    │
                                                  └────────────┘

   MCP server ─── reads only via openReader (readonly handle) ─▶ agent
```

`init` runs the full pipeline once. The watcher (`@lodestone/ingest/watcher`) keeps the index live by re-running the affected slice on file changes, debounced by `[ingest].debounce_ms` and paused during git operations when `[ingest].pause_during_git = true`.

## What's deferred to v0.5+

- Pro mode (multi-repo, Docker-Compose, shared index)
- Leiden clustering as an alternative to Louvain
- A numbered-migrations runner (v0 treats `.lodestone/` as ephemeral; reindex from scratch on schema bumps — see [`UPGRADE.md`](./UPGRADE.md))
- KuzuDB as a graph-engine alternative
- The bigger `nomic-embed-code` weights as an opt-in profile (`LODESTONE_ALLOW_MODEL_DOWNLOAD=1` reserved for this)
- GPU acceleration (tracked separately; not in v0 scope)

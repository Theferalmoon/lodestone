<!-- SPDX-License-Identifier: Apache-2.0 -->

# Lodestone — Technical Specification

This is the canonical engineer-facing surface for Lodestone v0.1.x. It merges and supersedes the older split across `docs/ARCHITECTURE.md`, `docs/CONFIG.md`, `docs/MCP-TOOLS.md`, and `docs/SUPPLY-CHAIN.md` for the purposes of the CMNDI-DOCS-MANDATE-001 doc surface. Those four files are still the authoritative day-to-day developer references and are cross-linked below; they are not duplicated here in full.

For the privacy claim and its enforcement, see [`../PRIVACY.md`](../PRIVACY.md). For the open-issue tracker, see [`../KNOWN-ISSUES.md`](../KNOWN-ISSUES.md). For security posture, see the project's `LICENSE` plus the build-time URL audit described in PRIVACY.md.

## 1. System overview

Lodestone v0 is a single-process, project-local Knowledge Graph that lives entirely inside `.lodestone/` in the repository it indexes. One `npm install` (or `npx lodestone init`) gets a friend running. There is no Python sidecar, no Go agent, no helper service. The CLI, the ingest pipeline, the embedder, the storage layer, the clusterer, the skill emitter, and the MCP server are all TypeScript on Node 20+.

For the why-Node-only rationale, the why-Louvain rationale, the why-SQLite rationale, and the friend-mode-vs-Pro-mode framing, see [`../ARCHITECTURE.md`](../ARCHITECTURE.md). This spec section summarizes the locked v0 stack:

- **Runtime:** Node 20+, TypeScript, ESM throughout.
- **Parsers:** `web-tree-sitter` (WASM) + `tree-sitter-{typescript,javascript,python,go,rust}`.
- **Embedder:** profiled bundled ONNX models, inferenced via `@xenova/transformers`. Friend `lite` bundles Snowflake 384d; friend `full` bundles Nomic 768d. Internal `default`, `tiny`, and reserved `pro` config values remain for runtime selection and forward compatibility.
- **Storage:** `better-sqlite3` (synchronous) + `sqlite-vec` extension. WAL mode. Foreign keys on. Reader handle opened readonly at the driver layer.
- **Graph:** `graphology` + `graphology-communities-louvain`.
- **MCP server:** `@modelcontextprotocol/sdk` over local stdio.

## 2. Monorepo layout

```
lodestone/
├── packages/
│   ├── shared/        # Types, schemas, envelope, paths, net chokepoint
│   ├── cli/           # `lodestone` binary + commands
│   ├── ingest/        # Embedder + parsers + graph + store + clusterer + skill emitter + watcher
│   └── mcp-server/    # @lodestone/mcp-server — the 8 MCP tools
├── e2e/               # End-to-end harness: orchestrator, network interceptor, synthetic demo repo
├── docs/              # Developer docs + the CMNDI doc surface under cmndi/
├── package.json       # pnpm workspace root
├── pnpm-workspace.yaml
└── pnpm-lock.yaml
```

### Per-package responsibilities

- **`@lodestone/shared`** — zero-runtime-dependency type and schema package. Owns `LodestoneToolResponse<T>`, `Provenance`, `Diagnostics`, the `lodestone.toml` zod schema, `LodestoneSymbol` / `Edge` / `Cluster` types, the SQLite schema (canonical row types), and the network chokepoint (`assertNetworkAllowed`, `LODESTONE_OFFLINE` enforcement). Every other package imports types from here.
- **`@lodestone/cli`** — the user-facing binary. Owns `init`, `status`, `reindex`, `doctor`, `seed-skills`, `setup-models`, `upgrade`, and `uninstall`. Routes subcommands; renders progress bars; loads `lodestone.toml`; orchestrates ingest pipeline calls.
- **`@lodestone/ingest`** — the heavy package. Subpath exports for `embed`, `parsers`, `graph`, `store`, `clusterer`, `skill-emitter`, `seed-skills`, and `watcher`. Each subsystem is independently testable. The MCP server reads from this package's `store` subpath via the `openReader` handle.
- **`@lodestone/mcp-server`** — the MCP protocol surface. Owns the eight tool implementations, the response envelope wrapper, the in-flight cap, the response-size truncator, the cross-store ready-gate, and the local-stdio trust assertion. Boots via `createServer()`.

## 3. Data flow

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

## 4. Storage schema

All persisted database state lives in a single SQLite database at `.lodestone/lodestone.sqlite`. The schema version is recorded in the `schema_version` table and surfaced as `CURRENT_SCHEMA_VERSION` in `@lodestone/shared`. The current value is `3`.

Useful tables:

| Table | Holds |
|---|---|
| `symbols` | One row per parsed symbol. `id`, `name`, `kind`, `path`, `range`, `pagerank`, `cluster_id` (mirrored from `cluster_members`), `updated_at_commit`. |
| `edges` | Directed graph edges (caller → callee, importer → imported). Weighted. |
| `class_inheritance` | Subset of edges promoted to a typed inheritance relation. |
| `clusters` | Louvain communities. `id`, `name`, `name_status` (`heuristic` \| `human`), `naming_evidence` JSON. |
| `cluster_members` | Many-to-many between symbols and clusters. |
| `skills` | Emitted SKILL.md cards. Maturity tag (`seed` \| `emerging` \| `mature`), confidence, anchor symbols. |
| `feedback` | Agent feedback events keyed by prior `request_id`. |
| `symbol_embeddings` | sqlite-vec virtual table holding per-symbol embedding vectors. Dimension is mirrored in `index_meta`. |
| `index_meta` | Epoch oracle, embedder profile, schema version, ingest-completion marker. |

The `index_meta` epoch is the cross-store ready-gate every reader-tool checks before responding (see §6.3). A reader hitting an in-progress reindex returns `provenance.source = "not_ready"` rather than serving stale or partial rows.

Schema bumps within v0.x require `lodestone reindex --from-scratch`. The numbered-migrations runner is v0.5+ work — see [`../UPGRADE.md`](../UPGRADE.md).

## 5. Embedder runtime

The friend installer publishes two profiled ingest tarballs. The `lite` profile bundles `snowflake-arctic-embed-s` (ONNX int8, 384 dimensions). The `full` profile bundles `nomic-embed-text-v1.5` (ONNX int8, 768 dimensions). The internal `default`, `tiny`, and `pro` config values are still used by `lodestone.toml`; in profiled release tarballs, the runtime auto-selects the bundled model that is actually present.

Inference goes through `@xenova/transformers` (Apache 2.0; ONNX Runtime under the hood). The packaged `lite` and `full` runtime paths make zero outbound calls; the operator's machine never speaks to Hugging Face for embedding. The **only** reserved runtime fetch path is `lodestone setup-models --allow-download`, gated by two consents (operator `--allow-download` flag plus the `LODESTONE_OFFLINE` chokepoint). The public v0.1.x build also exits before network until real pinned hashes are published. See [`../PRIVACY.md`](../PRIVACY.md) for the full opt-in model.

### Consent-gated download path

```bash
# Public v0.1.x behavior: refuses before any network call because live
# setup-models pins are not published yet.
lodestone setup-models --embedder nomic-text-v1.5
# → exits non-zero with "setup-models is not enabled in this public v0.1.x build"

# Future pinned build, opt in explicitly:
lodestone setup-models --embedder nomic-text-v1.5 --allow-download
# → public v0.1.x exits before network until real setup-models pins ship.
# → future pinned builds still hit assertNetworkAllowed("setup-models: ...")
#   and so still fail when LODESTONE_OFFLINE=1.
```

Once real pins ship, weights land per-project at `<repoRoot>/.lodestone/models/<id>/`, never in a shared global cache. Each downloaded file is sha256-verified against a pinned manifest baked into the CLI binary; a mismatch quarantines the file and exits non-zero.

## 6. MCP tool surface

Lodestone exposes eight tools over the Model Context Protocol. The tool set is registered from a single `TOOL_REGISTRY` map in `packages/mcp-server/src/tools/index.ts`; the server has no per-tool wiring beyond that map.

For per-tool input/output schemas, JSON examples, and "when not to use" guidance, see [`../MCP-TOOLS.md`](../MCP-TOOLS.md). This spec section covers the universal envelope, the registration model, and the cross-store ready-gate.

### 6.1 The universal envelope

Every Lodestone tool returns the same outer shape:

```typescript
interface LodestoneToolResponse<T> {
  request_id: string;       // UUID v7, server-generated. Used by feedback() to reference this call.
  results: T[];             // Per-tool payload. Always an array, even for "context" (one symbol).
  provenance: Provenance;   // Git + index state at the moment the tool ran.
  diagnostics: Diagnostics; // Coverage, warnings, truncation/clamp flags.
}
```

`Provenance` carries the head commit, the indexed commit, dirty-tree flags, upstream-branch state, the staleness in seconds, and a `source` field set to `"live"`, `"stale"`, or `"not_ready"`. `Diagnostics` carries `coverage` (0..1, files-indexed-vs-non-ignored), an optional `warnings` array, an optional `truncated` flag, and an optional `clamped` flag.

The full schema (with sentinel values for never-indexed and non-git directories) is in `packages/shared/src/types/envelope.ts`.

### 6.2 The eight tools

| Group | Tool | One-line purpose |
|---|---|---|
| Search | `query` | Hybrid semantic + lexical + PageRank-weighted symbol search. |
| Search | `recent_changes` | Symbols touched by recent commits. Git-aware, no shell-out on the request path. |
| Graph | `context` | One-symbol 360 view: definition, callers, callees, cluster, skill cards. |
| Graph | `impact` | Recursive reverse-reachability over `edges`. Run before editing. |
| Moat | `cluster` | Louvain community matching name-or-query. Returns naming evidence + `agent_instruction`. |
| Moat | `skills_for` | Codebase-specific SKILL cards for a task description. |
| Write | `feedback` | Agent thumbs-up / thumbs-down on a prior call. Only write tool. |
| Gated | `sql` | Read-only SQLite escape hatch. Registered only when `[mcp].dangerous_tools_enabled = true` AND `"sql"` is in `[mcp].expose`. |

### 6.3 The cross-store ready-gate

Every reader-tool checks the `index_meta` epoch oracle before responding. If the epoch indicates an in-progress reindex (or a never-completed first ingest), the tool returns an empty payload with `provenance.source = "not_ready"` rather than serving partial or stale rows. This invariant was added in §08 RED #4 (see commit `d20e55f`) after the e2e harness caught a class of MCP responses that read across a half-rebuilt store.

Agents should treat `source === "not_ready"` as preliminary and back off briefly rather than retrying tightly.

### 6.4 The `sql` gate

`sql` is the only tool flagged `dangerous: true` in the registry. It will not register at server boot unless **both**:

1. `[mcp].dangerous_tools_enabled = true` in `lodestone.toml`, AND
2. `"sql"` is in `[mcp].expose`.

The shared config schema also enforces both conditions at parse time (see `packages/shared/src/config/schema.ts` `mcpSchema.refine`). Defense-in-depth: neither layer alone is sufficient if the other ever drifts.

The connection underlying `sql` is opened readonly at the driver level so write attempts (INSERT, UPDATE, DELETE, DROP) throw — but exposing arbitrary read access to the index is still a power-user feature, not a default.

## 7. Configuration

Lodestone reads `.lodestone/lodestone.toml` from the project root. `lodestone init` writes a sensible default. The full key reference (every key, type, default, allowed values, env-var override) is in [`../CONFIG.md`](../CONFIG.md). The zod schema in `packages/shared/src/config/schema.ts` is the source of truth; the docs test will fail CI if a key is added there but not documented in CONFIG.md.

Notable env-var-only flags:

| Variable | Effect |
|---|---|
| `LODESTONE_OFFLINE=1` | Block every outbound network call. The chokepoint in `@lodestone/shared/net/fetch` throws `NetworkBlockedError` with a clear reason. The load-bearing variable for the privacy claim. |
| `LODESTONE_ALLOW_MODEL_DOWNLOAD=1` | Per-shell consent gate for `lodestone setup-models`. Equivalent to passing `--allow-download` per invocation. |
| `LODESTONE_LOG_LEVEL` | `error` \| `warn` \| `info` \| `debug`. CLI and worker verbosity. Default `info`. |
| `LODESTONE_COMMIT_HASH` | Build-time injection of the commit hash into `lodestone --version`. Source checkouts fall back to runtime `git rev-parse`; installed packages under `node_modules` use packaged `dist/build-info.json`, then `dev`. |
| `LODESTONE_DANGEROUS_TOOLS` | Wires the `[mcp].dangerous_tools_enabled` config from the environment for ephemeral test setups. |

## 8. Watcher

`@lodestone/ingest/watcher` keeps the index live. It uses `chokidar` over the operator's filesystem, debounces by `[ingest].debounce_ms`, pauses during git operations (detected via `.git/index.lock`) when `[ingest].pause_during_git = true`, and queues changed files into the affected-slice ingest path.

Key behaviors hardened in the §12 review pass (see commit `ee95ec0`):

- **Floods are split** so a 10k-file refactor doesn't materialize as one giant queue entry.
- **Queue-cap backpressure** prevents memory blow-up; excess entries fail loudly rather than silently dropping.
- **Replay-safe kinds** ensure `add` / `change` / `unlink` events that arrive out of order do not desynchronize the store.

## 9. Install / uninstall lifecycle

`lodestone init` is the install entry point. It detects project languages, writes `.lodestone/lodestone.toml`, scaffolds the SQLite + sqlite-vec store, runs the first ingest pass (no model fetch on the default profile — weights are bundled), and writes a `.mcp.json` snippet the operator's MCP-aware editor picks up.

`lodestone uninstall` is the inverse. It uses a manifest schema (v2) recorded at install time so the uninstaller knows exactly which files and directories it created. The schema is forward-strict: an uninstaller from a future Lodestone version refuses to operate on a manifest with an unknown future schema version (better to fail loudly than to delete the wrong files). Partial-failure paths preserve the manifest so the operator can finish manually. See commit `6319783` for the §04+§19 hardening pass.

## 10. Supply chain posture

Every direct dependency is Apache 2.0 or MIT. Lodestone itself is Apache 2.0. The full per-dependency table (license + maintainer-org origin + role in the system) is in [`../SUPPLY-CHAIN.md`](../SUPPLY-CHAIN.md). The bundled embedder weights are also Apache 2.0 (Nomic AI for `nomic-embed-text-v1.5`; Snowflake for the `tiny` fallback).

Maintainer-org provenance was vetted against the CMNDI supply-chain mandate before vendoring. PRC-origin and Russia-origin model providers are excluded — including the `nomic-embed-CODE` family, which is built on a `Qwen2.5-Coder-7B` base and is therefore disqualified despite the parent org being acceptable. The code-aware embedder slot in v0.5 is reserved for a Mistral- or Granite-based model from a vetted maintainer.

## 11. Build-time URL audit

Every CI build runs a grep over the shipped `dist/` directory looking for `https://` URLs and fails on anything not on the documented allowlist. The allowlist lives in two places that have to agree:

- [`../../network-manifest.json`](../../network-manifest.json) at the repo root — the human-readable, reviewer-facing list of every URL Lodestone is allowed to contact, paired with the chokepoint that gates each one.
- `packages/shared/src/net/__tests__/no-outbound-urls.test.ts` — the machine-readable allowlist consumed by the audit. Every entry carries a `reason` field.

The audit runs in two places, both as gates: locally inside `pnpm -r test`, and in CI as a dedicated `Privacy audit — no outbound URLs in dist/` step inside `.github/workflows/ci.yml`. The full enumeration of permitted URLs and their gating chokepoints is in [`../PRIVACY.md`](../PRIVACY.md).

## 12. What is deferred to v0.5+

- **Pro mode** — multi-repo, Docker-Compose orchestrated, shared index. The `--pro` flag is wired to a clean exit message in v0; the bundled stack ("Lodestone Forge") is the v1+ companion product, planned to start after Lodestone v0 has been dogfooded for ~1 week.
- **Temporal KG** — Pro-only graph history: node/edge history, reconstructable snapshots, "as of commit/date" queries, changed-between graph diffs, and retention controls. v0 friend mode stays current-state only with git-aware recent changes.
- **Leiden clustering** — wired but not exercised. Louvain is the v0 default because the Node implementation is mature.
- **Numbered-migrations runner** — first migration that genuinely cannot be a from-scratch reindex is the embedder-dim swap, which is the v0.5 trigger.
- **Code-aware embedder** — gated on a vetted, US/allied-jurisdiction maintainer. `LODESTONE_ALLOW_MODEL_DOWNLOAD=1` is reserved for it.
- **GPU acceleration** — tracked separately; not in v0 scope. Apple Silicon CoreML EP is the closest thing today; install `onnxruntime-node@latest` to pick it up.
- **Specialty agent plugins** — first concrete planned agent is `lodestone.review_diff` (the follow-behind reviewer). Sketched at `local-opus-lab/docs/plans/2026-05-01-coding-kg-product/sections/section-23..28*.md` against the v0.5 plan.

## 13. Cross-references

| Surface | Lives at |
|---|---|
| Engineer day-to-day docs | `docs/ARCHITECTURE.md`, `docs/CONFIG.md`, `docs/MCP-TOOLS.md`, `docs/SUPPLY-CHAIN.md` |
| Privacy claim + enforcement | [`../PRIVACY.md`](../PRIVACY.md) |
| Open issues | [`../KNOWN-ISSUES.md`](../KNOWN-ISSUES.md) |
| Upgrade + schema versioning | [`../UPGRADE.md`](../UPGRADE.md) |
| Operator troubleshooting | [`../TROUBLESHOOTING.md`](../TROUBLESHOOTING.md) |
| Synthetic demo repo | [`../DEMO-REPO.md`](../DEMO-REPO.md) |
| License + relicensing authorization | `LICENSE`, `NOTICE`, `LICENSE-AUTHORIZATION.md` |

<!-- SPDX-License-Identifier: Apache-2.0 -->

# Configuration reference

Lodestone reads `.lodestone/lodestone.toml` from the project root. `lodestone init` writes a sensible default; this document describes every key. Defaults match the zod schema in `packages/shared/src/config/schema.ts` — that file is the source of truth, and the `docs.test.ts` schema-walk test will fail CI if a key is added there but not documented here.

## Canonical example

```toml
[project]
name = "my-project"
languages = ["typescript", "javascript"]

[ingest]
mode = "watch"
debounce_ms = 600
ignore_extra = ["build/", "dist/", "vendor/"]
inherit_gitignore = true
pause_during_git = true

[embedder]
profile = "default"
batch_size = 16

[cluster]
algorithm = "louvain"
schedule = "nightly"
resolution = 1.5
alpha = 0.4
beta = 0.05
gamma = 0.4
min_weight = 0.3

[skill_emitter]
enabled = true
seed_on_init = true
min_size = 3
max_size = 50
min_age_days = 2
expire_days = 60

[mcp]
expose = ["query", "context", "impact", "cluster", "skills_for", "recent_changes", "feedback"]
dangerous_tools_enabled = false
max_in_flight = 4
max_response_kb = 256

[pro]
enabled = false
docker_compose_path = "./pro/docker-compose.yml"
```

## `[project]`

Required block. Identifies the project to Lodestone.

| Key | Type | Default | Description |
|---|---|---|---|
| `name` | string | _required_ | Project name. Used in the `.mcp.json` snippet `lodestone init` writes and in CLI output. Must be non-empty. |
| `languages` | string[] | `[]` | Source languages to index. Allowed values: `"typescript"`, `"javascript"`, `"python"`, `"go"`, `"rust"`. Empty array means "auto-detect from file extensions during init." |

## `[ingest]`

How the ingest pipeline behaves on startup and on file changes.

| Key | Type | Default | Description |
|---|---|---|---|
| `mode` | enum | `"watch"` | `"watch"` keeps the index live via the file watcher. `"manual"` ingests once and never re-runs until you call `lodestone reindex`. |
| `debounce_ms` | int (≥0) | `600` | Milliseconds the watcher waits after the last file event before triggering a re-ingest of the affected slice. Higher = fewer ingests, slightly staler index. |
| `ignore_extra` | string[] | `[]` | Additional path patterns (gitignore syntax) to exclude on top of `.gitignore`. Use for build outputs, vendored code, generated files. |
| `inherit_gitignore` | bool | `true` | When true, every entry in the project's `.gitignore` is also ignored by the watcher and the ingest scanner. |
| `pause_during_git` | bool | `true` | When true, the watcher pauses re-ingest while a git operation is in progress (detected via `.git/index.lock`). Prevents thrash during `git checkout` / `git rebase`. |

## `[embedder]`

Which embedding model and how it batches.

| Key | Type | Default | Description |
|---|---|---|---|
| `profile` | enum | `"default"` | `"default"` prefers bundled `nomic-embed-text-v1.5` when present. In the friend `lite` release tarball, the runtime auto-selects the bundled `snowflake-arctic-embed-s` model instead. `"tiny"` pins Snowflake. `"pro"` is reserved for v0.5+ and currently behaves like `"default"`. |
| `batch_size` | int (≥1) | `16` | Symbols per inference batch. Higher uses more RAM during ingest; lower is friendlier on small machines. The pipeline auto-clamps when free RAM is low. |

`lodestone reindex` reads this profile before loading the embedder. Set `profile = "tiny"` to pin index-time embeddings to `snowflake-arctic-embed-s`; an explicit `LODESTONE_EMBEDDER` environment override still wins for operator debugging. Friend install profiles (`LODESTONE_PROFILE=lite|full`) control which model is packaged into the release tarball; this TOML key controls runtime selection inside an installed project.

## `[cluster]`

Community detection over the symbol-and-call graph.

| Key | Type | Default | Description |
|---|---|---|---|
| `algorithm` | enum | `"louvain"` | `"louvain"` is the v0 default (Node implementation is mature). `"leiden"` is wired but not exercised in v0; treat as deferred. |
| `schedule` | string | `"nightly"` | Pattern: `"nightly"` (run once per day), `"manual"` (only when `lodestone reindex` is called), or `"on_change_threshold:<N>"` (re-cluster after N changed symbols). |
| `resolution` | float (>0) | `1.5` | Louvain resolution parameter. Higher → more, smaller clusters. Lower → fewer, larger clusters. |
| `alpha` | float (0..1) | `0.4` | Edge-weight contribution from call frequency. |
| `beta` | float (0..1) | `0.05` | Edge-weight contribution from file co-location. |
| `gamma` | float (0..1) | `0.4` | Edge-weight contribution from PageRank-weighted shared neighbors. |
| `min_weight` | float (0..1) | `0.3` | Minimum edge weight to feed into Louvain. Prunes noisy edges before community detection. |

`alpha + beta + gamma` need not sum to 1; they are independent multipliers.

## `[skill_emitter]`

Controls which clusters become emitted SKILL.md cards.

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | bool | `true` | Master switch. When false, no SKILL cards are written and `skills_for()` returns empty. |
| `seed_on_init` | bool | `true` | When true, `lodestone init` runs the deterministic seed-skills extractor (error hierarchies, framework detection) so day-1 `skills_for()` returns useful results. |
| `min_size` | int (≥1) | `3` | Minimum cluster member count to be eligible for emission. Prevents tiny clusters from generating low-signal cards. |
| `max_size` | int (≥1) | `50` | Maximum cluster member count for emission. Larger clusters are usually too generic to summarize as a single skill. Must be ≥ `min_size`. |
| `min_age_days` | int (≥0) | `2` | A cluster must persist (same membership) for this many days before emission. Filters out churn from refactors-in-progress. |
| `expire_days` | int (≥0) | `60` | SKILL cards older than this many days without re-confirmation are archived. Must be ≥ `min_age_days`. |

## `[mcp]`

How the MCP server presents itself.

| Key | Type | Default | Description |
|---|---|---|---|
| `expose` | string[] | see below | Tool names to register. Allowed values: `query`, `context`, `impact`, `cluster`, `skills_for`, `recent_changes`, `feedback`, `sql`. Default exposes everything except `sql`. |
| `dangerous_tools_enabled` | bool | `false` | When false, `sql` cannot be added to `expose` (the schema rejects it). Set to true to enable the read-only SQLite escape hatch. |
| `max_in_flight` | int (≥1) | `4` | Concurrent in-flight tool calls. Excess calls receive a `BackpressureError` rather than queue. |
| `max_response_kb` | int (≥1) | `256` | Per-response size cap. Larger responses are truncated and `diagnostics.truncated = true` is set on the envelope. |

Default `expose`:
```toml
expose = ["query", "context", "impact", "cluster", "skills_for", "recent_changes", "feedback"]
```

`sql` is intentionally absent. To enable it both `dangerous_tools_enabled = true` AND `"sql"` in `expose` are required; the schema enforces both.

## `[pro]`

Pro-mode flags. v0 honors only `enabled`; the rest is plumbing for v0.5+.

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | bool | `false` | When true, `lodestone init --pro` enters the (deferred) Pro setup flow. In v0 this prints "Pro mode is v0.5+ work" and exits cleanly. |
| `docker_compose_path` | string | `"./pro/docker-compose.yml"` | Reserved for v0.5+. Path to the Pro-mode Docker Compose file. Ignored in v0. |

## Environment variable overrides

Some runtime flags are env-var-only because they apply across the toolchain (CLI, ingest workers, MCP server) and would not fit cleanly into TOML.

| Variable | Values | Description |
|---|---|---|
| `LODESTONE_OFFLINE` | `"1"` to enable | Block every outbound network call. The chokepoint in `@lodestone/shared/net/fetch` throws `NetworkBlockedError` with a clear reason. Recommended for air-gapped or paranoid setups. See [`PRIVACY.md`](./PRIVACY.md). |
| `LODESTONE_LOG_LEVEL` | `error` \| `warn` \| `info` \| `debug` | CLI and worker log verbosity. Default is `info`. |
| `LODESTONE_COMMIT_HASH` | string | Build-time injection of the commit hash into the CLI's `--version` output. If unset, `lodestone --version` falls back to a runtime `git rev-parse`, then to `dev`. |
| `LODESTONE_ALLOW_MODEL_DOWNLOAD` | `"1"` to enable | Reserved for v0.5+. Will gate the larger `nomic-embed-code` weights opt-in. Currently a no-op. |

`LODESTONE_OFFLINE=1` is the load-bearing one for the privacy claim. Set it in your shell profile or your editor's MCP config block.

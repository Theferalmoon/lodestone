<!-- SPDX-License-Identifier: Apache-2.0 -->

# Upgrading Lodestone

v0 follows the standard semver shape (`MAJOR.MINOR.PATCH`). Within v0.x, schema-breaking changes are allowed but documented. From v1.0 onward, schema-breaking changes will require a numbered migration. Until then, treat `.lodestone/` as a regenerable cache.

## How to upgrade the CLI

If you installed globally:

```bash
npm install -g @lodestone/cli@latest
```

If you run via `npx`:

```bash
npx lodestone@latest
```

`npx` resolves the latest published version on each invocation, so you are always on the newest release. The trade-off is a small startup cost on the first run after a release.

## How to verify the install version vs the on-disk schema version

```bash
lodestone doctor
```

Reports the installed CLI version, the schema version recorded in `.lodestone/store/lodestone.db`, and whether they agree. If they do not, the doctor prints the recommended action (usually `lodestone reindex --from-scratch`).

`lodestone --version` prints the version + commit-hash one-liner without doing the rest of the doctor probes.

## Schema versions in v0

The current schema version is recorded in the SQLite `schema_version` table and surfaced as `CURRENT_SCHEMA_VERSION` in `@lodestone/shared`. Any upgrade between v0.x versions that bumps that constant requires a from-scratch reindex:

```bash
lodestone reindex --from-scratch
```

This deletes `.lodestone/store/` and rebuilds from a fresh ingest pass. For a 10k-symbol repo this takes under a minute on a modern laptop. The watcher state, the SKILL.md cards under `.lodestone/skills/`, and the `lodestone.toml` config are all preserved across a from-scratch reindex.

## Why no migration runner in v0

A numbered-migrations runner was scoped out of v0 in favor of getting the index design right first. The current pattern (treat `.lodestone/` as ephemeral, reindex on schema bumps) is acceptable for friend mode because:

- Reindex is fast.
- The index is per-project and not shared, so no coordination is needed.
- We want the freedom to evolve the SQLite schema during the v0.x window without locking in migration paths we will regret at v1.0.

The numbered-migrations runner is the first thing on the v0.5 roadmap. It will land alongside the embedder-dim swap (the bigger `nomic-embed-code` weights, gated by `LODESTONE_ALLOW_MODEL_DOWNLOAD=1`) — that swap is the first migration that genuinely cannot be a from-scratch reindex because it changes the embedding dimension and would require re-embedding every symbol regardless.

## v0 → v0.1 → v0.5 path (forward-looking)

| Version | What changes | Upgrade action |
|---|---|---|
| v0.1.x | Bug fixes only; no schema bumps. | `npm install -g @lodestone/cli@latest`. |
| v0.2 / v0.3 / v0.4 | Possible schema bumps; minor feature additions (more languages, better seed skills, ranking improvements). | Each release notes whether a from-scratch reindex is required. The doctor will tell you. |
| v0.5 | Pro mode, numbered migration runner, embedder-dim swap option. | First version with proper migrations; from-scratch reindex no longer required for schema bumps that have a migration. |
| v1.0 | Locked schema; semver-strict migration policy; backwards-compat guarantees. | Standard `npm install -g @lodestone/cli@latest`. |

## Bigger embedder upgrade (opt-in fetch path)

The default ship bundles both `nomic-embed-text-v1.5` int8 (~150 MB) and `snowflake-arctic-embed-s` int8 (~33 MB) inside the npm package — no runtime download needed for the privacy-first happy path.

Friends who want to upgrade to a larger embedder (e.g. the future `nomic-fp16` weights, or who want to re-fetch a missing or corrupted file) can opt in to a one-shot, consent-gated fetch:

```bash
# Either set the env var once for the shell:
export LODESTONE_ALLOW_MODEL_DOWNLOAD=1
lodestone setup-models --embedder nomic-fp16

# …or pass the flag per-invocation:
lodestone setup-models --embedder nomic-fp16 --allow-download
```

The command will refuse to run unless one of these consent paths is taken. It also routes through `assertNetworkAllowed()` (the §18 chokepoint), so `LODESTONE_OFFLINE=1` blocks the fetch even with explicit consent — both gates must permit.

Weights land at `<repoRoot>/.lodestone/models/<id>/`. Each project keeps its own copy; nothing leaks across friends or projects.

Useful flags:

| Flag | Effect |
|---|---|
| `--embedder <id>` | Fetch only the named embedder (repeatable). Default: every embedder in the manifest. |
| `--target <path>` | Override the per-project model directory (`<repoRoot>/.lodestone/models/`). |
| `--allow-download` | Per-invocation consent. Equivalent to setting `LODESTONE_ALLOW_MODEL_DOWNLOAD=1` for one run. |
| `--force` | Re-download even when the file is present and the sha256 matches. |

Each downloaded file is sha256-verified against a pinned manifest baked into the CLI binary. A mismatch causes the file to be quarantined (deleted) and `setup-models` exits non-zero.

When the bundled weights are missing entirely, `lodestone init` and `lodestone reindex` print a hint pointing at this command rather than failing silently.

## Reserved env vars for upgrades

| Variable | Effect |
|---|---|
| `LODESTONE_ALLOW_MODEL_DOWNLOAD=1` | Operator consent gate for `lodestone setup-models`. Without this (or the `--allow-download` flag), the command refuses to touch the network. |

## Known breaking changes

None for v0.1.0 — this is the first ship. Future releases will list breaking changes here, with the date and the recommended migration path.

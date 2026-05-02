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

## Reserved env vars for upgrades

| Variable | Effect |
|---|---|
| `LODESTONE_ALLOW_MODEL_DOWNLOAD=1` | Reserved for v0.5+. Will gate the larger `nomic-embed-code` weights opt-in (a multi-hundred-MB download). Currently a no-op on v0.1.0. |

## Known breaking changes

None for v0.1.0 — this is the first ship. Future releases will list breaking changes here, with the date and the recommended migration path.

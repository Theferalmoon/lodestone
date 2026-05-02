<!-- SPDX-License-Identifier: Apache-2.0 -->

# Lodestone

A project-local code-aware Knowledge Graph for coding agents.

**Your code never leaves your machine.**

```bash
npx lodestone init
```

See [`docs/README.md`](./docs/README.md) for the friend onboarding guide (authored as part of the documentation pass).

## Developer bootstrap (clean machine)

Requires Node 20+ and a network connection for `pnpm install`. From a clean checkout:

```bash
# Enable corepack + activate the pinned pnpm version
corepack enable
corepack prepare pnpm@10.33.0 --activate

# Install workspace deps + run tests
pnpm install
pnpm test
```

`pnpm test` is currently network-dependent (it runs `pnpm audit` against the npm registry). Once package code lands in §02+, `pnpm -r test` runs the per-package suites which are hermetic.

## Maintainer-only: bundling embedder weights before publish

Lodestone ships its embedders (Nomic 768d default + Snowflake 384d low-RAM fallback) **inside the npm tarball** so that friends never make a runtime network call to Hugging Face. This is what makes the "your code never leaves your machine" promise defensible.

The weights live under `packages/ingest/models/` (gitignored, ~185 MB) and are copied into `packages/ingest/dist/models/` at build time. Maintainers populate them once before publishing:

```bash
# 1. Download both bundled embedders from Hugging Face into packages/ingest/models/
#    Idempotent — skips files whose sha256 matches packages/ingest/models-manifest.json.
pnpm --filter @lodestone/ingest bundle-models

# 2. Build everything. The ingest build step copies models/ -> dist/models/.
pnpm -r build
```

Friends never run `bundle-models`. The script intentionally bypasses the runtime offline guard (`assertNetworkAllowed()` in `@lodestone/shared/net/fetch`) because it is a build-pipeline-only step that runs on the maintainer's workstation, not in the friend's installed copy. See the header comment in `packages/ingest/scripts/bundle-models.mjs` for the build-time-network-exception rationale.

To bump a pinned model revision:

```bash
# Edit MODELS[].hfRevision in scripts/bundle-models.mjs, then:
pnpm --filter @lodestone/ingest bundle-models -- --update-manifest
# Review the updated models-manifest.json diff before committing.
```

## License

Apache-2.0. See [`LICENSE`](./LICENSE), [`NOTICE`](./NOTICE), and [`LICENSE-AUTHORIZATION.md`](./LICENSE-AUTHORIZATION.md).

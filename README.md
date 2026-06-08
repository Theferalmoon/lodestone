<!-- SPDX-License-Identifier: Apache-2.0 -->

# Lodestone

A project-local code-aware Knowledge Graph for coding agents.

**Your code never leaves your machine.**

## Download-only friend install

In your friend's project directory, have them run:

```bash
cd /path/to/their/project
git checkout -b add-lodestone
curl -sSfL https://lodestone.cmndi.ai/install | bash
```

This downloads the approved Lodestone release tarballs, verifies their SHA-256 checksums, installs them into `./node_modules`, and runs `lodestone init` for that project. The embedder weights are bundled inside the install, so there is no runtime model fetch and Lodestone does not upload your source code. During install, npm can still download the normal dependency tree required by the Lodestone packages.

Friends do not need collaborator access to this repository. They can download and install Lodestone into their own repo, but they cannot push changes to the canonical Lodestone repo unless the operator explicitly adds them as GitHub collaborators.

**Profiles.** The default `lite` profile uses the Snowflake 384d embedder; the tarball download is ~16 MB. For advanced setups that want the larger Nomic 768d embedder, pass `LODESTONE_PROFILE=full` (~178 MB tarball download):

```bash
curl -sSfL https://lodestone.cmndi.ai/install | LODESTONE_PROFILE=full bash
```

**Disk footprint.** The numbers above are what you actually download from the GitHub release. After `npm install`, the full `./node_modules` tree — Lodestone plus its transitive npm dependencies (tree-sitter parsers, `better-sqlite3`, `onnxruntime-node`, ~240 others) — is **~1 GB** in either profile. The bulk on disk is the npm dep tree, not Lodestone itself. Plan accordingly on metered/slow connections.

**Pinning.** The friend installer defaults to the approved `v0.1.4` package set. To make that explicit:

```bash
curl -sSfL https://lodestone.cmndi.ai/install | LODESTONE_VERSION=v0.1.4 bash
```

**Access.** The `Theferalmoon/lodestone` repo is currently public, so no GitHub auth is required to fetch this installer or the release tarballs. The `lodestone.cmndi.ai/install` URL is a brand URL for the installer and should point at an immutable installer ref, not a mutable development branch.

See [`docs/FRIEND-INSTALL.md`](./docs/FRIEND-INSTALL.md) for the plain-English friend onboarding guide and [`docs/README.md`](./docs/README.md) for the technical guide. (Note: the npm `npx lodestone init` path is future work; today's working install path is the curl one-liner above.)

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

Lodestone ships its embedders (Nomic 768d for the `full` profile, Snowflake 384d for the `lite` profile) **inside the per-profile `@lodestone/ingest` tarball** so that friends never make a runtime network call to Hugging Face. This is what makes the "your code never leaves your machine" promise defensible. Each release ships two ingest tarballs (`-lite` and `-full`); `scripts/pack-profile.sh` strips the OTHER profile's `dist/models/` subdir from the package before `npm pack` so friends only download the weights they actually use.

Both embedder dirs live under `packages/ingest/models/` in the workspace (gitignored, ~185 MB combined). They are copied into `packages/ingest/dist/models/` at build time, then split per-profile at pack time. Maintainers populate them once before publishing:

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

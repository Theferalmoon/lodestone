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

## License

Apache-2.0. See [`LICENSE`](./LICENSE), [`NOTICE`](./NOTICE), and [`LICENSE-AUTHORIZATION.md`](./LICENSE-AUTHORIZATION.md).

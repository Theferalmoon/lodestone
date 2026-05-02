<!-- SPDX-License-Identifier: Apache-2.0 -->

# The synthetic demo repo

`e2e/synthetic-demo-repo/` is a hand-built, multi-language fixture that doubles as a teaching example. The end-to-end test harness exercises the full Lodestone pipeline against it (`pnpm -r test`), and you can point your own editor's coding agent at it to see the moat tools in action without standing up a real project first.

## What's in it

A small five-language project with deterministic call graphs, import edges, and class hierarchies. The files are arranged so that the Louvain clusterer reliably partitions them into recognizable architectural subsystems:

- **TypeScript service (`src/`)** — `auth.ts`, `api.ts`, `db.ts`, `util.ts`. The TypeScript subsystem demonstrates the canonical router-handler-service-repo split. `util.log()` is referenced by every module, so it tops the PageRank ranking.
- **Python scripts (`scripts/`)** — `seed.py`, `migrate.py`. Demonstrates a SeedError exception family the error-hierarchy seed-skill scanner picks up.
- **Go CLI (`cli/`)** — `main.go`, `handler.go`. Demonstrates the Go-specific package + import graph the parser builds.
- Plus small JavaScript (`web/server.js`, `web/routes.js` — both import Express, so the framework-detector seed skill fires) and Rust (`native/`) modules so all five v0 languages are exercised.

The TypeScript files also intentionally seed an `AppError` / `AuthError` / `DbError` / `ApiError` hierarchy so the error-hierarchy seed-skill scanner has obvious work to do at init time.

`FIXTURE_MANIFEST.json` declares the predictions the e2e test asserts against — expected file count ranges, the three architectural subsystems, the expected seed skills, the high-PageRank anchors, the expected query results, and the expected MCP tools to be registered. Treat it as the contract; if a Lodestone change breaks one of those predictions, the e2e fails loudly.

## Why synthetic and not a real OSS project

Three reasons:

1. **Reproducibility.** Real OSS projects drift. A test asserting "X function should be in cluster Y" against a moving target rots in weeks. A synthetic repo we control does not drift.
2. **Predictability.** The cluster names, the seed skills, the high-PageRank anchors are all known in advance. We can write tight assertions without flake.
3. **We control the example.** Adding a new language (say, Java in v0.5) is one new directory in this fixture, plus one new entry in the manifest. No external dependency, no waiting on an upstream maintainer.

The cost is that the demo repo is small and obviously synthetic. It is a teaching example, not a representative codebase. For a realistic feel, point Lodestone at one of your own real projects after the demo flow makes sense.

## How to use it as a teaching example

```bash
git clone https://github.com/<your-org>/lodestone.git
cd lodestone
pnpm install
pnpm -r build

cd e2e/synthetic-demo-repo
node ../../packages/cli/dist/bin/lodestone.js init
```

Now `e2e/synthetic-demo-repo/.lodestone/` is populated. Open Claude Code (or any MCP-aware editor) in that directory; it will pick up the `.mcp.json` snippet `init` wrote.

Try:

> *what are the main subsystems of this codebase?*

The agent should call `cluster()` and read back at least three communities matching the TypeScript service, the Python scripts, and the Go CLI. Then:

> *find the user login authentication flow*

The agent should call `query()` with a question close to that and surface a result whose path contains `src/auth.ts`.

> *what are the conventions for handling errors here?*

The agent should call `skills_for()` and surface the error-hierarchy seed skill (extracted from the `AppError` family in `src/util.ts` plus the `SeedError` family in `scripts/seed.py`).

If any of those calls return something unexpected on a stock checkout, file an issue — the manifest is the contract.

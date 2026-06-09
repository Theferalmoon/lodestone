<!-- SPDX-License-Identifier: Apache-2.0 -->

# Supply chain

Lodestone keeps its dependency graph small, predictable, and auditable. This document explains why the bundled embedder, the major libraries, and the rebuilt dependency tree look the way they do. The short version: every bundled model and every load-bearing library is permissively licensed (Apache 2.0 or MIT), United States-origin, and pulled from an official maintainer organization.

## Why these specific models

### Full-profile embedder: `nomic-embed-text-v1.5`

Bundled inside the `full` `@lodestone/ingest` release tarball as ONNX int8. ~150 MB on disk. No runtime network fetch is required when the model is bundled.

- **Maintainer:** Nomic AI (United States).
- **License:** Apache 2.0.
- **Source:** the official `nomic-ai` Hugging Face organization.
- **Why bundled:** the privacy claim ("your code never leaves your machine") only holds if the install does not phone home at runtime. Bundling the weights costs install size; we accept the trade for the `full` profile.

### Lite-profile embedder: `snowflake-arctic-embed-s`

Bundled inside the `lite` `@lodestone/ingest` release tarball as ONNX int8. Smaller than the full-profile model and used for the default friend install. No runtime network fetch is required when the model is bundled. The internal `tiny` config path can still use Snowflake as a fallback in development or non-profiled builds.

- **Maintainer:** Snowflake (United States).
- **License:** Apache 2.0.
- **Source:** the official `Snowflake` Hugging Face organization.

### Why no PRC-origin or Russia-origin model weights

We chose to keep the dependency graph predictable and auditable. PRC-origin model providers (and their derivatives) were excluded after weighing supply-chain risk: opaque training-data provenance, opaque tokenizer construction, and the practical difficulty of vetting dependencies whose maintainer org we cannot reach. This is a hygiene call, not a political one. The same standard rules out any model whose base we cannot trace to a permissively-licensed United States or allied-jurisdiction maintainer.

The English-only `nomic-embed-text` family and Snowflake Arctic family meet that bar. The code-aware `nomic-embed-code` model is built on a PRC-origin base and is explicitly excluded; if a future profile needs code-aware embeddings, the candidate is a Mistral- or Granite-based model from a vetted maintainer.

## Why these specific libraries

Major runtime dependencies, with license and origin:

| Package | License | Origin | What it does |
|---|---|---|---|
| `vectordb` (LanceDB) | Apache 2.0 | LanceDB (United States) | Reserved for v0.5+ vector store work. Not on the v0 hot path; v0 uses sqlite-vec. |
| `kuzu` | MIT | Kuzu Labs (Canada) | Reserved for v0.5+ graph engine work. Not on the v0 hot path. |
| `web-tree-sitter` | MIT | Tree-sitter project (United States) | The WASM parser runtime. One library, one AST shape per language. |
| `@xenova/transformers` (transformers.js) | Apache 2.0 | Xenova / Hugging Face (Canada) | ONNX-Runtime-backed inference for the bundled embedder. |
| `graphology` | MIT | Yomguithereal (France) | The in-process graph data structure used by the clusterer. |
| `graphology-communities-louvain` | MIT | Same maintainer as graphology | Louvain community detection on top of graphology. |
| `chokidar` | MIT | Paul Miller (United States) | The file watcher used by `@lodestone/ingest/watcher`. Cross-platform, well-maintained. |
| `@modelcontextprotocol/sdk` | MIT | Anthropic (United States) | The MCP server surface and stdio transport. |
| `better-sqlite3` | MIT | Joshua Wise (United States) | Synchronous SQLite driver. Pairs with sqlite-vec for the vector store. |
| `sqlite-vec` | Apache 2.0 | Alex Garcia (United States) | The sqlite-vec extension provides the symbol-embedding virtual table. |
| `zod` | MIT | Colin McDonnell (United States) | Schema validation across every package boundary (config, envelope, MCP inputs). |
| `smol-toml` | MIT | Cynthia Foxwell (Canada) | TOML parser used to read `lodestone.toml`. |

The full transitive dependency tree was reviewed before v0.1.0. New direct dependencies require a license + origin check; the rule is documented in the contributor guidelines.

## Apache 2.0 by default; MIT where permissive

Every direct dependency is Apache 2.0 or MIT. Lodestone itself is Apache 2.0 (see [`../LICENSE`](../LICENSE) and [`../NOTICE`](../NOTICE)). There is no copyleft on the dependency graph. There are no proprietary blobs. There is no vendored third-party binary outside the bundled ONNX weights, which are also Apache 2.0.

## A note on the rebuilt dependency tree

The v0 dependency graph was rebuilt from scratch — every transitive dependency walked, every license read, every maintainer org checked. The audit lives in the workspace lockfile (`pnpm-lock.yaml`) and in the per-package `package.json` files; `pnpm audit` is a CI gate. The v0.1.6 friend-install release prep also pins patched transitive releases for packages that were advisory-sensitive at release time, so `pnpm audit --prod` is clean as of 2026-06-08. The public friend installer carries the same intent into npm consumer projects by adding a root npm override for `protobufjs@7.5.8` before install.

If you want to verify any of the above on your machine: `pnpm why <package>` shows where a dep entered the graph; `pnpm audit` lists open advisories; the Hugging Face model card pages link directly to the maintainer organization.

## The network manifest

Every URL Lodestone is allowed to contact — at install, build, or future pinned model-setup time — is enumerated in [`../network-manifest.json`](../network-manifest.json) at the repo root, paired with the gate that has to fire before the URL is reached. The CI privacy audit (`.github/workflows/ci.yml` → `Privacy audit — no outbound URLs in dist/`) treats anything not on that list landing in shipped `dist/` as a build failure. The public v0.1.x setup-models command exits before network until real hashes ship; see [`PRIVACY.md`](./PRIVACY.md) for how the two-gate consent path interacts with the manifest.

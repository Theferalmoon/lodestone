<!-- SPDX-License-Identifier: Apache-2.0 -->

# Lodestone — Talking Points

Bullet-list reference for demos, interviews, and Q&A. Use these as starting points; the full claims are backed in the technical spec, the operator guide, and the brochure.

## The 30-second pitch

> Lodestone is a project-local Knowledge Graph for coding agents. It runs as a single npm install, parses your repo with tree-sitter, embeds every symbol locally with a bundled ONNX model, clusters the call graph into emergent architectural modules, emits codebase-specific SKILL cards, and exposes the whole thing to your editor's coding agent over MCP. Your code never leaves your machine. Apache 2.0. Eight MCP tools. Five languages. Works with Claude Code, Cursor, Cline, cmndclaw — anything that speaks MCP.

## The 6 differentiators

1. **Local-only by default.** Bundled embedder weights ship inside the npm tarball. Day-1 use makes zero outbound calls. The privacy promise is enforced by a build-time URL audit that fails CI on anything new in shipped `dist/`.
2. **MCP-native.** Works with every MCP-aware client today and tomorrow without per-editor adapter work. Claude Code, Cursor, Cline, cmndclaw — same eight tools, same envelope.
3. **KG-shaped, not snippet-shaped.** Most code-search products return file snippets. Lodestone returns symbols, edges, clusters, naming evidence, blast-radius graphs, and skill cards. The agent reasons over structure, not over text.
4. **Vendor-curated dependency tree.** Every direct dep Apache 2.0 or MIT, every maintainer org reviewed for license + origin before vendoring. PRC- and Russia-origin model providers explicitly excluded — including code-aware embedders whose base model is disqualified.
5. **Apache 2.0 with documented relicensing provenance.** `LICENSE-AUTHORIZATION.md` records the rights-holder authorization for the CMNDI algorithmic-core components extracted into Lodestone v0. Not a copy-paste relicense — a documented provenance trail.
6. **Single process, single SQLite file, one `npm install`.** No Python sidecar. No helper service. No cloud account. Friend mode is the v0 ship; "Pro mode" multi-repo is wired but exits cleanly with a "v0.5+ work" message.

## Quick numbers (for slides)

- **8** MCP tools
- **5** languages parsed (TypeScript, JavaScript, Python, Go, Rust)
- **4** workspace packages (`shared`, `cli`, `ingest`, `mcp-server`)
- **106** test files in the workspace + e2e harness
- **~16 MB / ~89 MB** release tarball download for `lite` / `full`
- **0** runtime model network calls on packaged friend installs
- **Apache 2.0**, every direct dep
- **v0.1.5** friend-install package set

## FAQ

### Can I self-host?

Lodestone runs entirely on the operator's machine — there is nothing to "host." If you mean "run inside an air-gapped network": yes. Pull the npm package once on a build host, carry it in, set `LODESTONE_OFFLINE=1` in the shell profile. The bundled weights make day-1 use work without any outbound calls.

### What about model updates?

Friend ship: `lite` bundles Snowflake 384d and `full` bundles Nomic 768d. The reserved `lodestone setup-models --allow-download` path is for future larger or alternate model weights, but the public v0.1.x build exits before network until real pinned hashes are published. Per-project model cache, never a shared global cache.

### How do you keep secrets?

Lodestone has no secrets to keep. There is no API key. There is no account. There is no service to authenticate to. The whole tool runs as a Node process that reads your repo and writes to `.lodestone/` next to it. The MCP server runs over local stdio — only your editor talks to it.

### What's the GPU footprint?

Zero in v0. Inference goes through `@xenova/transformers` over CPU. On Apple Silicon, install `onnxruntime-node@latest` and the CoreML execution provider routes inference through the Neural Engine for a 3-5× speedup. GPU acceleration is a separate roadmap item, not in v0 scope.

### How big a repo can it handle?

The v0 friend-repo target is up to ~50k symbols. A 10k-symbol repo first-ingests in under a minute on a modern laptop. For larger monorepos, use `--max-symbols <N>` to cap, add aggressive `[ingest].ignore_extra` entries to exclude generated/vendored code, or wait for v0.5 Pro mode (multi-repo, sharded ingest).

### Why Louvain instead of Leiden?

Mature Node implementation. Louvain is ~3x simpler to operate at our scale and has predictable runtime up to ~50k symbols. Leiden is wired (so the swap is one line of config) but not exercised in v0; treating it as a v0.5 deferred item rather than shipping unstable bindings.

### Why SQLite instead of LanceDB + KuzuDB?

The original plan was LanceDB for vectors and KuzuDB for the graph. After the §08 implementation pass we collapsed both into SQLite + sqlite-vec because (a) the graph queries Lodestone actually runs are well-served by recursive CTEs over an `edges` table, and (b) keeping one process, one file, and one transaction model dramatically simplified the install surface for friends on macOS, Linux, and WSL2. Trade: we lose some peak vector-search throughput; we gain a one-process install.

### Why Apache 2.0 and not AGPL?

Apache 2.0 is the friendliest license for a tool that wants to live inside other people's build pipelines and inside private deployments. AGPL would have forced corporate users into a posture they cannot accept. Lodestone is meant to be embedded — Apache 2.0 fits the wedge.

### Does it learn from my code?

Locally, yes. The `feedback` MCP tool (called voluntarily by the agent after a useful or unhelpful tool call) writes events to your local SQLite. Those events feed the cluster-name-promotion pipeline and the skill-card-maturation pipeline — but the events stay on disk in your `.lodestone/`. Nothing is sent anywhere. There is no shared model across users.

### Does it work with Claude Code? Cursor? Cline? cmndclaw?

All four. The `.mcp.json` snippet `lodestone init` writes is consumed by every MCP-aware client. Eight tools, same envelope, no per-editor adapter. cmndclaw's plugin chain (CMNDI's autonomous coding agent) wires it alongside the cartridge-driven inference router.

### What's the relationship to "Lodestone Forge"?

Forge is the planned v1+ companion product — a Docker-Compose bundle that ships the full multi-KG stack to friend customers (per-project code KG = lifts Lodestone, plus operational KG, coding training corpus, federation router, LoRA training factory). Lodestone is the single-KG per-project npm and stays useful standalone forever. Forge planning starts after Lodestone v0 has been dogfooded against `local-opus-lab` for ~1 week.

### What if my agent calls `feedback` without a `request_id`?

The tool rejects the call. The `request_id` is how Lodestone correlates the signal to the call it should learn from; without it the event would be uncorrelated noise. The error response is structured so the agent can self-correct on the next attempt.

### What about transitive CVEs in the dep tree?

As of the v0.1.5 friend-install release prep on 2026-06-08, `pnpm audit --prod` is clean after patched transitive overrides. Treat audit status as live: rerun `pnpm audit --prod` during strict intake because registry advisories can change after release.

### How do I undo the install?

`lodestone uninstall`. Uses an install manifest (schema v2, recorded at install time) so the uninstaller knows exactly which files and directories `init` created. Refuses to operate on a manifest from a future schema version (better to fail loudly than to delete the wrong files). Partial-failure paths preserve the manifest so you can finish manually.

## What we DO claim

- Your code never leaves your machine on the default profile.
- The privacy promise is enforced by a build-time URL audit, not just runtime behavior.
- Eight MCP tools work with every MCP-aware client.
- Apache 2.0, every direct dep Apache 2.0 or MIT, every maintainer org vetted.
- Five languages parsed in v0; cluster names emerge from Louvain communities; skill cards mature with index age.
- Friend mode is the v0 ship; Pro mode is wired but deferred.
- Production dependency audit clean at v0.1.5 release prep; rerun `pnpm audit --prod` for live intake.
- The synthetic demo repo at `e2e/synthetic-demo-repo/` is the contract — its `FIXTURE_MANIFEST.json` is what e2e asserts against, and a Lodestone change that breaks one of its predictions fails CI.

## What we DON'T claim

- We do not claim Lodestone replaces a code search engine for cross-repo work — v0 is single-repo by design.
- We do not claim "best embeddings on the planet" — we claim **vetted, US/allied-jurisdiction maintainer**, bundled, locally-runnable embeddings. Quality is good enough for the moat tools to work; it is not the SOTA frontier.
- We do not claim the seed skills extracted at init time are as rich as the emitted skills after a week of watching — they are a useful day-1 baseline, not a finished product.
- We do not claim multi-language extraction is bug-free — tree-sitter grammars occasionally choke on unusual syntax (decorators, nested f-strings, macros). The pipeline catches the parse error, marks the file as skipped, and moves on rather than crashing. `lodestone doctor` reports skipped files.
- We do not claim Pro mode works in v0 — it is wired to exit with a clean "v0.5+ work" message.
- We do not claim numbered-migrations across schema bumps — v0.x requires `lodestone reindex --from-scratch` on a schema bump. Migrations runner is v0.5.
- We do not claim GPU acceleration in v0.
- We do not quote performance numbers we have not measured. The number "10k symbols ingest in under a minute on a modern laptop" is the order of magnitude reflected in the synthetic-demo e2e harness; your mileage on a real codebase will vary.

## Demo flow (5 minutes)

1. `curl -sSfL https://lodestone.cmndi.ai/install | bash` in a real-ish project. Show the output (file count, symbol count, edge count, ingest time).
2. Show the `.mcp.json` snippet that init wrote.
3. Open Claude Code. Ask: *what are the main subsystems of this codebase?* — agent calls `cluster()`, reads back communities.
4. Ask: *find the rate-limit middleware* — agent calls `query()`, lands on the right symbol.
5. Ask: *what would break if I change the session-token rotator?* — agent calls `impact()`, returns the blast-radius set.
6. Show `lodestone status` — coverage, last ingest, watcher state.
7. Show `lodestone doctor` — env probe, offline-mode status, schema-version agreement.

End on the privacy point: nothing in the demo touched the network after `npm install`.

<!-- SPDX-License-Identifier: Apache-2.0 -->

# Lodestone — Brochure

## The pitch in three sentences

Coding agents work better when they understand the codebase, not just the file in front of them. Lodestone is a project-local Knowledge Graph that gives any MCP-aware coding agent — Claude Code, Cursor, Cline, cmndclaw — semantic search, graph navigation, codebase-specific skill cards, and impact analysis over a repository it has parsed, embedded, and clustered locally. **Your code never leaves your machine.**

## The privacy promise

Lodestone is a project-local tool. Embeddings, the call graph, cluster names, SKILL cards, feedback events, the SQLite index — everything is written to `.lodestone/` inside the project on disk. There is no telemetry endpoint. There is no upload step. There is no remote service to call. The MCP server runs locally over stdio and only the operator's editor talks to it.

The promise is enforced three ways:

1. **Bundled embedder weights.** The friend installer ships profiled ingest tarballs: `lite` bundles Snowflake 384d, `full` bundles Nomic 768d. Day-1 runtime makes zero outbound model calls.
2. **A single chokepoint for any future opt-in fetch.** The reserved fetch path is `lodestone setup-models --allow-download`, gated by both an explicit operator flag *and* the `LODESTONE_OFFLINE` env-var check. The public v0.1.x build also exits before network until real pinned hashes are published.
3. **Build-time URL audit.** Every CI build greps the shipped `dist/` for outbound URLs and fails on anything not on a hand-curated allowlist (`network-manifest.json`). The privacy claim is enforced at release time, not just at runtime.

For regulated industries, defense workloads, or any team that cannot upload proprietary source to a vendor: this is the wedge.

## Eight tools, one envelope

Every Lodestone tool returns the same outer shape — `request_id`, `results`, `provenance`, `diagnostics` — so the agent always knows how stale the data is. The tool surface:

| Tool | What the agent uses it for |
|---|---|
| **`query`** | Hybrid semantic + lexical + PageRank-weighted symbol search. The default discovery tool. |
| **`recent_changes`** | Git-aware "what just changed" without shelling out to git on the request path. |
| **`context`** | The 360 view of one symbol — definition, callers, callees, the cluster it belongs to. |
| **`impact`** | Recursive reverse-reachability over the call graph. Run *before* editing to scope blast radius. |
| **`cluster`** | The moat. Surfaces emergent architectural modules (auth, payments, ingest, etc.) with naming evidence and an `agent_instruction` directive. |
| **`skills_for`** | Codebase-specific SKILL cards (error-handling style, test idioms, naming conventions). The agent consults these *before* writing code so its output matches house style. |
| **`feedback`** | The single write tool. Agent thumbs-up / thumbs-down feeds the local training signal that improves cluster names and skill cards. |
| **`sql`** | Gated escape hatch. Read-only SQLite queries against the project index, registered only when the operator explicitly turns it on. |

## What makes it different

| Lodestone | Hosted code-search products (Cody / Cursor Tab / Copilot Workspace) |
|---|---|
| Local-only by default; bundled weights; consent-gated for any fetch | Source uploaded to vendor for indexing |
| MCP-native — works with every MCP-aware client | Custom IDE plugin per editor |
| Vendor-curated dependency tree — every dep Apache 2.0 / MIT, every maintainer org vetted | Dependency posture is opaque to the operator |
| KG-shaped output — clusters, edges, naming evidence | Mostly file-snippet retrieval |
| Apache 2.0 — fork it, audit it, run it inside an air-gapped network | Vendor-licensed |
| One `npm install`; one process; one SQLite file | Hosted service + IDE client + cloud account |

The differentiation is not just "we don't upload" — it's "you get the moat tools (clusters, impact, skill cards) without giving up control of the code." For most teams that is a feature; for regulated teams it is a hard requirement.

## Use cases

### Friend customer — onboarding a new agent to an existing codebase

A friend customer wires Lodestone into Claude Code on their company laptop. Day 1: run the curl installer, ask the agent "what are the main subsystems of this codebase?", confirm the clusters look right. Day 2-7: skills emerge as the watcher observes the project; `skills_for("write a new API handler")` starts returning the team's house style. Week 2: agent edits land that match the project's conventions on first shot.

### Regulated team — code grounding without code egress

A defense or finance team runs an MCP-aware editor inside an air-gapped network. Lodestone runs alongside, pulled once from an approved release host, then carried in. `LODESTONE_OFFLINE=1` is set in the shell profile. The agent gets the same eight tools as the public OSS user; the network never sees source. Compliance is the build-time URL audit and the reserved future fetch path staying fail-closed unless both consent and release pins exist.

### Solo engineer — getting an agent to actually understand the project

An engineer working on a 30k-symbol monorepo wires Lodestone into Cursor. Now `query("rate limiter middleware")` lands on the right symbol on the first hop, `impact()` on a session-token rotator surfaces the four downstream call sites the agent needs to test, and `cluster("auth")` returns the eleven files that genuinely make up the authentication subsystem — not the eighty files that contain the substring "auth".

### CMNDI alpha — bundle inside a friend-distribution stack

CMNDI ships Lodestone as the per-project sidecar inside the Lodestone Forge bundle (planned v1+). Forge wires Lodestone alongside an operational KG, a coding training corpus, a federation router, and a LoRA training factory — but Lodestone itself stays the per-project, never-egress core. The friend can run Lodestone standalone or inside the Forge stack.

## Honest limits

Lodestone v0 is the first ship. We are not pretending it is the last word.

- **Best results after the index has watched the repo for ≥7 days.** Skill cards mature from `seed` → `emerging` → `mature` based on cluster stability and confirmation signals. Fresh installs get useful seed skills (deterministic patterns extracted at init time) but the emitted cards genuinely get better with time.
- **Five languages in v0.** TypeScript / JavaScript / Python / Go / Rust. Adding a language is one new tree-sitter grammar plus a small extractor; we are doing the next batch on customer demand.
- **Friend mode only.** Multi-repo "Pro mode" is wired but exits with a clean "v0.5+ work" message. Temporal KG history is Pro-only; friend mode is a current-state local KG with git-aware recent changes. The companion product (Lodestone Forge — multi-KG, Docker-Compose-orchestrated) is the v1+ work.
- **No GPU acceleration.** Apple Silicon CoreML EP is the closest thing today; install `onnxruntime-node@latest` to pick it up. GPU support is tracked separately, not in v0 scope.
- **Production audit clean at v0.1.9 prep.** `pnpm audit --prod` is clean as of 2026-06-11 after patched transitive overrides. Registry advisories can change, so strict environments should rerun the audit during intake.

## How to try it

```bash
curl -sSfL https://lodestone.cmndi.ai/install | bash
```

That is the install. Restart your MCP-aware editor in the same directory. Ask the agent: *what are the main subsystems of this codebase?*

For the synthetic-demo-repo walkthrough (so you can feel the tool before pointing it at a real project), the e2e harness ships a multi-language fixture with deterministic clusters and seed skills — see [`./03-end-user-guide.md`](./03-end-user-guide.md) §5.

## Where Lodestone sits in the bigger product roadmap

Two products, one strategy:

| Product | Tier | Status | What it is |
|---|---|---|---|
| **Lodestone** (this) | C | v0.1.9 friend install | Single-KG per-project package set. Privacy-first. The local sidecar. |
| **Lodestone Forge** | C | Planned post-v0 dogfood | Docker-Compose bundle: per-project code KG (lifts Lodestone) + operational KG + coding training corpus + federation router + LoRA training factory. Friend wires DNS / secrets / GPU; Forge ships the logic. |

Both products federate by query — a friend on the Forge stack can route a question through one MCP entrypoint and get answers from the right channel (code / ops / training corpus) tagged so the calling agent knows which channel each hit came from. Lodestone alone is the per-project privacy-first wedge; Forge is the operator-side multi-channel stack.

## License + provenance

Apache 2.0. See `LICENSE`, `NOTICE`, and `LICENSE-AUTHORIZATION.md` at the repo root. The authorization document records the rights-holder relicensing of the algorithmic-core CMNDI components that were extracted into Lodestone v0 — public-distribution-grade provenance, not just a copy-paste relicense.

The dependency graph is Apache 2.0 / MIT throughout, every direct dep audited for license + maintainer-org origin before vendoring. PRC-origin and Russia-origin model providers are excluded — including code-aware embedders built on disqualified bases. Full per-dependency table at [`../SUPPLY-CHAIN.md`](../SUPPLY-CHAIN.md).

## In one sentence

Lodestone is the local KG sidecar that lets your coding agent understand your codebase without uploading a single byte.

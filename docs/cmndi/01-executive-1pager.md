<!-- SPDX-License-Identifier: Apache-2.0 -->

# Lodestone — Executive 1-Pager

**Version:** v0.1.9 friend-install package set
**License:** Apache 2.0 (public, download-only friend distribution)
**Status:** Friend install and dogfood phase open

## What it is

Lodestone is a project-local, code-aware **Knowledge Graph for coding agents**. It watches one repository, parses every source file with tree-sitter, builds a symbol-and-call graph, embeds each symbol locally with a bundled ONNX model, clusters the graph into emergent architectural modules with Louvain community detection, emits machine-readable SKILL cards for the patterns it sees, and exposes the whole thing to the operator's coding agent over the Model Context Protocol (MCP).

It is a single curl-based friend install away. It runs entirely on the operator's machine. There is no service to deploy, no account to create, no upload step.

## Who it is for

- **Privacy-first development teams** who cannot or will not send proprietary source code to a hosted LLM-grounding service.
- **Friend-distribution alpha customers** receiving the CMNDI agentic-coding stack who need a local KG sidecar for their MCP-aware editor.
- **Engineers using MCP-native editors** (Claude Code, Cursor, Cline, cmndclaw) who want their agent to actually understand the codebase it is editing — not just read the file in front of it.

## Why it matters

Hosted code-search and code-grounding services (Sourcegraph Cody, Cursor Tab, Copilot Workspace, etc.) require the operator to upload source to a vendor. For a meaningful slice of the market — regulated industries, defense, IP-sensitive teams, friend-of-CMNDI alpha — that single requirement closes the door. Lodestone closes that gap by shipping the moat (semantic + lexical + graph search; cluster-aware naming; codebase-specific SKILL cards) as a tool that runs locally and stays local.

The MCP-native surface is the second wedge. Every other code-grounding product is built around a custom IDE plugin. Lodestone speaks MCP and is therefore portable across every editor that has an MCP client — present and future — without per-editor engineering.

## Key numbers

| Metric | Value |
|---|---|
| Workspace packages | 4 (`@lodestone/shared`, `@lodestone/cli`, `@lodestone/ingest`, `@lodestone/mcp-server`) |
| MCP tools shipped | 8 (`query`, `recent_changes`, `context`, `impact`, `cluster`, `skills_for`, `feedback`, `sql`) |
| Languages parsed in v0 | 5 (TypeScript/TSX, JavaScript/JSX, Python, Go, Rust) |
| Test files | 106 across the workspace + e2e harness |
| Bundled model size | `lite`: Snowflake 384d (~16 MB release download); `full`: Nomic 768d (~89 MB release download) |
| Runtime network calls (packaged friend profiles) | Zero |
| Distribution | Download-only friend installer via the branded curl one-liner |
| License | Apache 2.0 (commercial-friendly; see `LICENSE` + `LICENSE-AUTHORIZATION.md`) |

## How it stays defensible

- **Bundled embedder weights** — the privacy claim only holds if the install does not phone home at runtime. Lodestone ships profiled ingest tarballs so day-1 use needs zero outbound model calls.
- **Build-time URL audit** — every release runs a grep over the shipped `dist/` against an explicit allowlist (`network-manifest.json`). Anything new fails the build. The privacy claim is enforced at release time, not just at runtime.
- **Two-gate consent for any future model fetch** — the reserved opt-in fetch path (`lodestone setup-models --allow-download`) requires both an explicit operator flag and a pass through the `LODESTONE_OFFLINE` chokepoint. The public v0.1.x build also exits before network until real pinned hashes are published.
- **MCP-portable** — runs over local stdio. Works with every MCP-aware client, today and tomorrow, with no per-editor adapter.

## What is on the v0.5 roadmap

- Multi-repo "Pro mode" + Docker-Compose orchestration (the `--pro` flag is wired but exits with a clear "v0.5+ work" message in v0).
- Temporal KG for Pro: historical node/edge state, "as of commit/date" graph questions, and changed-between graph diffs. Friend mode stays current-state only.
- Code-aware embedder swap (currently waiting on a vetted, US/allied-jurisdiction maintainer; PRC-origin code embedders are explicitly excluded).
- Numbered-migrations runner (today, schema bumps require `lodestone reindex --from-scratch`; a 10k-symbol repo rebuilds in under a minute).
- Specialty agent plugins (the `lodestone.review_diff` follow-behind reviewer is the first concrete planned tool, sketched in the v0.5 plan).

## Where it sits in CMNDI

Lodestone is the **single-KG per-project** OSS product. The planned v1+ companion product, **Lodestone Forge**, is the multi-KG packaged stack (per-project code KG + operational KG + coding training corpus + federation router + LoRA training factory) that ships as a Docker-Compose bundle to friend customers. Forge planning kicks off after Lodestone v0 has been dogfooded against `local-opus-lab` for ~1 week.

Friend customers eventually get both: Lodestone as the per-project sidecar, Forge as the operator-side multi-channel stack.

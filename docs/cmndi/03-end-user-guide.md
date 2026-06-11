<!-- SPDX-License-Identifier: Apache-2.0 -->

# Lodestone — Operator Guide

This is the end-to-end operator tutorial. It merges day-to-day usage from `docs/UPGRADE.md`, `docs/TROUBLESHOOTING.md`, `docs/DEMO-REPO.md`, and `docs/KNOWN-ISSUES.md` into a single onboarding surface for friend customers and CMNDI alpha. The original docs remain canonical for deeper detail; pointers below take you there.

## 1. Install in 60 seconds

Lodestone ships as an npm package. Requires Node 20+. From your project's repo root:

```bash
npx lodestone init
```

That command does the magic-moment work:

1. Detects your project's languages (TypeScript / JavaScript / Python / Go / Rust).
2. Writes `.lodestone/lodestone.toml` with sensible defaults.
3. Scaffolds the SQLite + sqlite-vec database at `.lodestone/lodestone.sqlite`.
4. Runs the first ingest pass — parses every source file, embeds each symbol locally with the bundled ONNX model (zero outbound calls on the default profile), builds the call graph, computes PageRank, runs Louvain clustering, emits seed SKILL cards.
5. Writes a `.mcp.json` snippet your editor's coding agent can pick up.

Expected output for a 10k-symbol project:

```text
[lodestone] detected languages: typescript, javascript
[lodestone] wrote .lodestone/lodestone.toml
[lodestone] bootstrapping SQLite + sqlite-vec store ...
[lodestone] first ingest: 1247 files, 8932 symbols, 14217 edges (12.4s)
[lodestone] wrote .mcp.json snippet — restart your MCP-aware editor to pick it up
[lodestone] done. Run `lodestone status` for index health.
```

If you prefer global install over `npx`:

```bash
npm install -g @lodestone/cli
lodestone init
```

## 2. Wire it to your editor

Lodestone exposes its tools over the Model Context Protocol (MCP). Any MCP-aware client picks it up via the `.mcp.json` snippet `init` writes.

### Claude Code

Restart Claude Code in the same directory. It reads `.mcp.json` automatically. Confirm the eight tools appear in the agent's tool list. Then ask:

> *what are the main subsystems of this codebase?*

The agent should call `cluster()` and read back the Louvain communities Lodestone discovered. That is the moment that justifies the install.

### Cursor

Cursor honors the same `.mcp.json` snippet. Open the project; Cursor's MCP client picks up the snippet on the next agent invocation.

### cmndclaw

The CMNDI autonomous coding agent. Run `cmndclaw` from the project root — its plugin chain includes the MCP client that reads `.mcp.json`. Lodestone tools register alongside the cartridge-driven inference tools.

### Cline / other MCP clients

Anything that speaks MCP will work. The `.mcp.json` snippet uses an absolute path (MCP clients require absolute paths), so cloning a repo with a committed `.mcp.json` to a different machine requires a fresh `lodestone init` first.

## 3. Daily commands

| Command | What it does |
|---|---|
| `lodestone init` | First-run install for a project. Idempotent — safe to re-run. |
| `lodestone status` | Index health: file count, symbol count, last ingest, watcher state, ready-gate status. |
| `lodestone reindex` | Re-run the affected slice. Safe at any time. |
| `lodestone reindex --from-scratch` | Rebuild `.lodestone/lodestone.sqlite`. ~1 minute on a 10k-symbol repo. Use after a schema bump or if `.lodestone/` is corrupt. |
| `lodestone doctor` | Probe the environment — Node version, git presence, RAM, proxy state, CoreML availability, WSL2 detection, offline-mode status, schema-version agreement between CLI and on-disk store. |
| `lodestone seed-skills` | Re-run the deterministic seed-skill scanners. Useful after adding new error classes or framework imports. |
| `lodestone setup-models --allow-download` | Reserved future opt-in fetch path. Public v0.1.x exits before network until real pinned hashes are published. |
| `lodestone upgrade` | Help text pointing at `npm install -g @lodestone/cli@latest`. |
| `lodestone uninstall` | Inverse of `init`. Removes only what `init` created (per the recorded install manifest). Refuses to operate on a manifest from a future schema version. |
| `lodestone --version` | Prints the version + commit-hash one-liner. |

## 4. Where things live (`.lodestone/` directory layout)

```
<your-repo>/.lodestone/
├── lodestone.toml          # Project config. Hand-editable.
├── ready.json              # Cross-store ready-gate marker. MCP tools check this before responding.
├── lodestone.sqlite        # SQLite + sqlite-vec. Symbols, edges, clusters, skills, embeddings, feedback.
├── runtime/
│   └── ...                 # Watcher state, MCP server transport bookkeeping.
├── skills/
│   └── *.md                # Emitted SKILL cards. Hand-readable. Agents read via skills_for().
├── models/                 # Per-project model cache; future setup-models path only.
└── install-manifest.json   # Records what `init` created, for `lodestone uninstall` to undo.
```

Treat `.lodestone/` as a regenerable cache. v0 has no migration runner; if anything gets corrupt, `lodestone reindex --from-scratch` rebuilds in under a minute on most projects.

The `lodestone.toml` and any hand-edited skill cards are preserved across a from-scratch reindex; `.lodestone/lodestone.sqlite` is rebuilt fresh.

## 5. Try the synthetic demo first

If you want to feel the tool before pointing it at a real project, the repo ships with a multi-language fixture at `e2e/synthetic-demo-repo/`. It is small, deterministic, and built so the cluster names + seed skills + high-PageRank anchors are predictable.

```bash
git clone https://github.com/<your-fork>/lodestone.git
cd lodestone
pnpm install
pnpm -r build

cd e2e/synthetic-demo-repo
node ../../packages/cli/dist/bin/lodestone.js init
```

Open Claude Code (or any MCP-aware editor) in the demo dir. Ask:

> *what are the main subsystems of this codebase?*

Should surface at least three communities (TypeScript service, Python scripts, Go CLI). Then ask:

> *find the user login authentication flow*

Should land on `src/auth.ts`. And:

> *what are the conventions for handling errors here?*

Should surface the `AppError` / `SeedError` hierarchy via `skills_for`.

If any of those calls return something unexpected on a stock checkout, the `FIXTURE_MANIFEST.json` is the contract — file an issue. The full demo-repo writeup is at [`../DEMO-REPO.md`](../DEMO-REPO.md).

## 6. Common errors and fixes

### "MCP server failed to start: ENOENT" after cloning a repo

A teammate cloned a repo that has a committed `.mcp.json` file. The path inside the snippet is absolute under `.lodestone/runtime/` (MCP clients require absolute paths) and that path doesn't exist on a fresh clone. Fix:

```bash
npx lodestone init
```

If you'd rather have no init friction, simply do not commit `.mcp.json`.

### File watcher misses changes on WSL2

If your project sits at `/mnt/c/code/...` under WSL2, file events from Windows-side changes are not reliably propagated to the Linux-side inotify watcher. Move the project to the WSL2 native filesystem (`~/code/...`). This is a Windows-side limitation, not Lodestone-side.

### Slow embedding pass on Apple Silicon

`lodestone doctor` reports `CoreML EP not available`. Install the latest `onnxruntime-node`:

```bash
npm install -g onnxruntime-node@latest
# (or `pnpm add onnxruntime-node@latest` if developing inside the workspace)
```

Restart your editor. CoreML routes ONNX inference through Apple's Neural Engine.

### Corporate proxy / TLS interception breaks fetch

Stick to the bundled-model default profile (`[embedder].profile = "default"`) — it does not fetch. The public v0.1.x setup-models path exits before network until real pinned hashes are published. For full air-gap, `LODESTONE_OFFLINE=1` blocks all future fetch paths loudly.

### "no prebuild found for your platform"

Lodestone v0 ships prebuilds for `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64` (all glibc). Other platforms (musl-libc Alpine, FreeBSD, riscv64) need a build-from-source pass:

```bash
npm install --build-from-source @lodestone/cli
```

File an issue with `uname -ms` and `node -p process.platform+'-'+process.arch` and we will add the platform to the build matrix.

### "schema_version mismatch" / `.lodestone/` is corrupt

```bash
lodestone reindex --from-scratch
```

That rebuilds the store from scratch. v0 has no migration runner — see the v0.5 roadmap. The `lodestone.toml` and the `.lodestone/skills/` directory are preserved across the rebuild.

### "Pro mode is v0.5+ work"

`lodestone init --pro` is wired to a clean exit with this message. Pro mode (multi-repo, shared index, Docker-Compose orchestrated) is deferred. Use `lodestone init` without `--pro` for friend mode.

### Tree-sitter parse failures on individual files

Usually safe to ignore. Tree-sitter grammars occasionally choke on unusual syntax (experimental TypeScript decorators, deeply-nested Python f-strings, Rust macros expanding to non-grammar tokens). The ingest pipeline catches the parse error, marks the file as skipped, and moves on. `lodestone doctor` prints which files were skipped and why. If a file you care about is consistently skipped, file an issue.

### Friend's repo is huge (>50k symbols)

- Use `--max-symbols <N>` on `lodestone init` or `lodestone reindex` to cap how many symbols are persisted.
- Add aggressive entries to `[ingest].ignore_extra` to exclude generated code, vendored libraries, large test fixtures.
- Increase `[ingest].debounce_ms` from 600 to 2000 to reduce watcher churn.
- Pro mode (multi-repo, sharded ingest) is on the v0.5+ roadmap.

The full troubleshooting matrix is at [`../TROUBLESHOOTING.md`](../TROUBLESHOOTING.md).

## 7. Privacy posture in one paragraph

Default install: zero outbound network calls at runtime. The reserved opt-in fetch path is `lodestone setup-models --allow-download`, which requires both an explicit operator flag and the absence of `LODESTONE_OFFLINE=1`; the public v0.1.x build also exits before network until real pinned hashes are published. Set `LODESTONE_OFFLINE=1` in your shell or your editor's MCP config block to make the privacy guarantee unconditional. The full implementation lives at [`../PRIVACY.md`](../PRIVACY.md), including the build-time grep audit that fails CI on any unexpected URL in shipped `dist/`.

## 8. Upgrading

```bash
# Globally installed:
npm install -g @lodestone/cli@latest

# Or via npx (resolves latest on every invocation):
npx lodestone@latest
```

To verify the install vs the on-disk schema:

```bash
lodestone doctor
```

If the CLI version expects a newer schema than the store has, the doctor prints the recommended action — usually `lodestone reindex --from-scratch`. The full upgrade path (semver expectations, what changes between v0.x releases, when migrations land) is at [`../UPGRADE.md`](../UPGRADE.md).

## 9. Known issues at v0.1.x

- **Production audit status** — `pnpm audit --prod` is clean as of the v0.1.9 friend-install release prep on 2026-06-11. Registry advisories can change, so rerun the audit as a live check before strict security signoff.
- **No migration runner** — by design. Schema bumps within v0.x require `lodestone reindex --from-scratch`. v0.5 ships the runner alongside the embedder-dim swap option.
- **A handful of cosmetic items from the §20 e2e pass** — parser edge resolution edge cases, `LODESTONE_DB_PATH` env-var alignment, init/reindex command split. Tracked in §22 backlog; not happy-path.

The full list lives at [`../KNOWN-ISSUES.md`](../KNOWN-ISSUES.md).

## 10. Where to ask for help

- **Configuration questions** — read [`../CONFIG.md`](../CONFIG.md), then file an issue.
- **MCP tool questions** — read [`../MCP-TOOLS.md`](../MCP-TOOLS.md) for per-tool contracts and JSON examples, then file an issue.
- **Architecture / "why does it do that?"** — read [`../ARCHITECTURE.md`](../ARCHITECTURE.md) and the technical spec at [`./02-technical-spec.md`](./02-technical-spec.md).
- **Friend customers** — your CMNDI alpha onboarding contact is the fastest path. Friend support is private-channel by design until v0 broadens.
- **Public OSS users** — file a GitHub issue with the output of `lodestone doctor`.

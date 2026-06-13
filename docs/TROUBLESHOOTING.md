<!-- SPDX-License-Identifier: Apache-2.0 -->

# Troubleshooting

Common install and runtime issues, with the symptom first and the fix second. If you hit something not on this list, run `lodestone doctor` — it probes the environment (Node version, git presence, RAM, proxy state, CoreML availability, WSL2 detection) and prints a structured report you can paste into an issue.

## WSL2 path issues

**Symptom:** `lodestone init` runs from a WSL2 shell but the file watcher misses changes, or ingest is mysteriously slow on a project at `/mnt/c/code/...`.

**Fix:** clone the project to the WSL2 native filesystem (`~/code/...`), not under `/mnt/c/`. The `/mnt/c/...` path is a 9P FUSE mount; file events on Windows-side changes are not reliably propagated to the Linux-side inotify watcher chokidar uses. Symptoms range from missed events to permission errors. Native WSL2 paths work correctly. This is a Windows-side issue, not Lodestone-side; it affects every Linux file watcher running under WSL2.

## Corporate proxy / Zscaler / TLS interception

**Symptom:** install hangs on the snowflake fallback fetch (with `[embedder].profile = "tiny"`), or `lodestone doctor` reports network probes failing.

**Fix:**
- Set `HTTPS_PROXY` and `NO_PROXY` in your shell. Lodestone respects standard Node proxy environment variables.
- If your corporate proxy intercepts TLS, install the corporate root CA on the machine (`NODE_EXTRA_CA_CERTS=/path/to/corp-ca.pem`).
- Alternatively: stay on the bundled-model default profile (`[embedder].profile = "default"`). It does not fetch.
- For full air-gap: set `LODESTONE_OFFLINE=1` and use the default profile. The runtime guard will throw a clear `NetworkBlockedError` if anything tries to fetch — useful for catching surprises.

## Apple Silicon: slow inference on M-series

**Symptom:** the embedding pass during `lodestone reindex` is 3 to 5 times slower than expected on an M1 / M2 / M3 / M4 Mac. Other Lodestone operations (parse, graph build, cluster) run at expected speed.

**Fix:** `lodestone doctor` reports the CoreML execution provider status. If it says "CoreML EP not available," install the latest `onnxruntime-node`:

```bash
pnpm add onnxruntime-node@latest
# or globally if running via `npx lodestone`:
npm install -g onnxruntime-node@latest
```

Restart your editor / re-run init. CoreML EP routes the ONNX inference through Apple's Neural Engine and brings throughput in line with x86_64.

## Missing prebuild for `better-sqlite3` or `sqlite-vec`

**Symptom:** `pnpm install` (or `npx lodestone init` first run) fails with `no prebuild found for your platform`.

**Fix:** Lodestone v0 ships prebuilds for:

- `darwin-arm64` (Apple Silicon)
- `darwin-x64` (Intel Mac)
- `linux-x64` (Ubuntu / Debian / Fedora / Pop!_OS, glibc-based)
- `linux-arm64` (Raspberry Pi 5 class, glibc-based)

If you are on a different platform (musl-libc Alpine, FreeBSD, riscv64, etc.) the prebuild will not be present. File an issue with your platform triple (`uname -ms` plus `node -p process.platform+'-'+process.arch`) and we will add it to the build matrix. As a workaround, `npm install --build-from-source @lodestone/cli` builds the native modules locally if you have a C++ toolchain installed.

## Tree-sitter parse failures on individual files

**Symptom:** `lodestone status` reports a small number of skipped files. Specific files in your project never appear in `query` results.

**Fix:** usually safe to ignore. Tree-sitter grammars occasionally fail on files using unusual syntax (TypeScript with experimental decorators, Python with deeply-nested f-strings, Rust with macros expanding to non-grammar tokens). The ingest pipeline catches the parse error, marks the file as skipped, and moves on rather than crashing. `lodestone doctor` prints which files were skipped and why. If a file you care about is consistently skipped, file an issue with the file content (or a redacted minimal repro) and we will look at the grammar version.

## Friend's repo is enormous (>50k symbols)

**Symptom:** initial ingest takes more than 10 minutes. Watcher CPU usage is sustained high.

**Fix:**
- Use `--max-symbols <N>` on `lodestone init` or `lodestone reindex` to cap how many symbols are persisted. Useful for monorepos where you want to focus on a subset.
- Add aggressive entries to `[ingest].ignore_extra` to exclude generated code, vendored libraries, and large test fixtures.
- Increase `[ingest].debounce_ms` from the default 600 to something like 2000 to reduce watcher churn during active edits.
- Pro mode (multi-repo, sharded ingest) is on the v0.5+ roadmap for repos that genuinely need it.

## Cloners-without-init see "MCP server failed to start"

**Symptom:** a teammate clones a repo that has a committed `.mcp.json` file. Their editor reports "MCP server failed to start: ENOENT" pointing at a path under `.lodestone/runtime/`.

**Fix:** this is by design. The `.mcp.json` snippet `lodestone init` writes uses an absolute path under `.lodestone/runtime/` (because MCP clients require absolute paths). That path does not exist on a fresh clone until init has been run. The fix is one command:

```bash
npx lodestone init
```

This is intentional — it forces every developer on a project to opt in to the local index. If you want to remove the friction entirely, do not commit `.mcp.json`; have each developer run `lodestone init` themselves.

## Codex does not show Lodestone tools

**Symptom:** Claude Code, Cursor, or another `.mcp.json` client can see
Lodestone, but Codex does not list the Lodestone MCP tools.

**Fix:** Codex uses project `.codex/config.toml` for project-scoped MCP
servers. Install with the Codex adapter:

```bash
curl -sSfL https://lodestone.cmndi.ai/install | LODESTONE_CLIENT=codex bash
```

Or refresh an already installed project without rebuilding the index:

```bash
./node_modules/.bin/lodestone init --client codex --no-reindex
```

Then verify:

```bash
./node_modules/.bin/lodestone doctor --client codex
```

If doctor reports a stale or missing Codex config, rerun the refresh command.
If doctor reports healthy config but Codex still does not load the server, make
sure Codex has trusted the project. Approve the Codex trust prompt for this
repo, then start a new Codex session if Codex was already open. Project-local
`.codex/config.toml` is not loaded for untrusted projects.

After that trust/restart step, collect a support smoke report if Codex still
does not list Lodestone tools:

```bash
./node_modules/.bin/lodestone client-smoke --client codex
```

That helper does not run Codex or edit global Codex settings. It validates the
project `.codex/config.toml`, checks that `.lodestone/runtime/lodestone-mcp`
exists and is executable, and prints exact `codex mcp list` and `codex exec`
commands a maintainer can run in a trusted smoke repo. This is useful because
noninteractive Codex sessions may not load project-local `.codex/config.toml`
the same way an already trusted interactive project does.

If you do not need Codex, skip the Codex adapter. The default `.mcp.json`
configuration still works for MCP-aware clients that read `.mcp.json`.

## `.lodestone/` is corrupt

**Symptom:** MCP tools return errors mentioning schema versions, or `lodestone status` reports the index in an inconsistent state.

**Fix:**

```bash
lodestone reindex --from-scratch
```

That rebuilds `.lodestone/lodestone.sqlite` from scratch. v0 has no migration runner; that is v0.5+ work. Until then, treat `.lodestone/` as a regenerable cache: a from-scratch reindex on a 10k-symbol repo takes under a minute. For the schema-bump path (e.g. embedder dim changes between versions), see [`UPGRADE.md`](./UPGRADE.md).

## `lodestone init` says "Pro mode is v0.5+ work"

**Symptom:** `lodestone init --pro` exits cleanly with the message "Pro mode is v0.5+ work; no files were changed."

**Fix:** this is the intended exit message. Pro mode (multi-repo, shared index, Docker-Compose orchestrated) is deferred to v0.5+. Use `lodestone init` without `--pro` for friend mode (the v0 ship target).

## `lodestone setup-models` says it is not enabled

**Symptom:** `lodestone setup-models --allow-download` exits before any network call and says setup-models is not enabled in the public v0.1.x build.

**Fix:** this is intentional. The public friend profiles already bundle their model weights. Use the default `lite` installer, or reinstall with `LODESTONE_PROFILE=full` if you want the larger bundled Nomic model. The live setup-models fetch path stays fail-closed until a future release publishes real pinned hashes.

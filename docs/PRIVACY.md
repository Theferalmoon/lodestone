<!-- SPDX-License-Identifier: Apache-2.0 -->

# Privacy

**Your code never leaves your machine.**

Lodestone is a project-local tool. Everything it produces — embeddings, the call graph, cluster names, SKILL.md cards, feedback events, the SQLite index — is written to `.lodestone/` inside your project on disk. There is no telemetry endpoint. There is no upload step. There is no remote service to call. The MCP server runs locally over stdio and only your editor talks to it.

## What stays local

| Thing | Where it lives | Who can read it |
|---|---|---|
| Source code | Your repo, like always | You |
| Symbol embeddings (vectors) | `.lodestone/store/lodestone.db` (sqlite-vec virtual table) | The Lodestone process, opened read-only by MCP |
| The call graph (symbols, edges, PageRank) | `.lodestone/store/lodestone.db` | Same |
| Cluster names + naming evidence | `.lodestone/store/lodestone.db` (`clusters` table) | Same |
| SKILL.md cards | `.lodestone/skills/*.md` | You; agents read via `skills_for()` |
| Feedback events (the agent's thumbs-up / thumbs-down) | `.lodestone/store/lodestone.db` (`feedback` table) | Same |
| Watcher state, ready marker | `.lodestone/runtime/`, `.lodestone/ready.json` | Same |

## What leaves the machine

In friend mode (the default), **nothing**. Once installed, Lodestone runs entirely offline.

The two scenarios where bytes might leave your machine are:

1. **Installing or upgrading Lodestone itself.** `npm install -g @lodestone/cli@latest` (or `npx lodestone@latest`) hits the public npm registry to fetch the package. This is a normal package install, no different from any other npm tool you use. The npm registry URL is the only outbound URL allowed in the shipped `dist/` (the build-time grep audit, below, enforces this).
2. **The `tiny` embedder profile on first use.** If you set `[embedder].profile = "tiny"` in your `lodestone.toml`, the snowflake-arctic-embed-s weights are fetched on first use from Hugging Face and cached locally. Subsequent runs use the cached copy. Setting `LODESTONE_OFFLINE=1` in your environment blocks this fetch with a clear error, in which case the cache must be pre-populated. The default profile bundles its weights — no fetch occurs.

That is the complete list. There is no third path.

## The `LODESTONE_OFFLINE=1` guard

If you want a hard guarantee, set `LODESTONE_OFFLINE=1` in your shell or in your editor's MCP config. This wires the chokepoint in `@lodestone/shared/net/fetch`: every outbound network call inside the Lodestone process passes through `assertNetworkAllowed()`, which throws `NetworkBlockedError` (with the call site named) when offline mode is active. Embedder fetches, model downloads, anything — they all go through this gate. Once on, network calls are not silently degraded; they fail loudly with a message naming the caller.

`lodestone doctor` reports the current offline-mode status so you can verify it without restarting your editor.

## The build-time grep audit

We enforce the "no outbound URLs" claim at release time, not just at runtime. Every CI build runs a grep over the shipped `dist/` directory looking for `https://` URLs. Any URL that appears must be on a documented allowlist; anything new fails the build. The current allowlist is:

- `https://registry.npmjs.org` — the npm registry, used only by `npm install` itself, not by the running tool

The audit lives in `packages/shared/src/net/__tests__/no-outbound-urls.test.ts` and runs in `pnpm -r test`. If you ever see a Lodestone release that has more URLs in its dist than this list, treat it as a bug and file an issue.

## No telemetry

There is no telemetry. No usage events, no error reports, no anonymous metrics. The closest thing is the `feedback` MCP tool, which the agent calls voluntarily after a useful or unhelpful tool call — but those events are written to your local `.lodestone/store/lodestone.db` and stay there. Nothing is sent anywhere.

## Verifying offline behavior locally

```bash
# Confirm the runtime guard is active.
LODESTONE_OFFLINE=1 lodestone doctor

# Try forcing a fetch under the guard. The tiny profile is the only path that
# would normally fetch; with OFFLINE=1 it should fail loudly with a clear error.
LODESTONE_OFFLINE=1 lodestone reindex --profile tiny --from-scratch
```

You can also confirm by network observation: watch your firewall or run `lodestone init && lodestone reindex` under `strace -e trace=network` (Linux) or Little Snitch (macOS) and you will see no outbound traffic on the default profile.

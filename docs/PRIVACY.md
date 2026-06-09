<!-- SPDX-License-Identifier: Apache-2.0 -->

# Privacy

**Your code never leaves your machine.**

Lodestone is a project-local tool. Everything it produces — embeddings, the call graph, cluster names, SKILL.md cards, feedback events, the SQLite index — is written to `.lodestone/` inside your project on disk. There is no telemetry endpoint. There is no upload step. There is no remote service to call. The MCP server runs locally over stdio and only your editor talks to it.

## What stays local

| Thing | Where it lives | Who can read it |
|---|---|---|
| Source code | Your repo, like always | You |
| Symbol embeddings (vectors) | `.lodestone/lodestone.sqlite` (sqlite-vec virtual table) | The Lodestone process, opened read-only by MCP |
| The call graph (symbols, edges, PageRank) | `.lodestone/lodestone.sqlite` | Same |
| Cluster names + naming evidence | `.lodestone/lodestone.sqlite` (`clusters` table) | Same |
| SKILL.md cards | `.lodestone/skills/*.md` | You; agents read via `skills_for()` |
| Feedback events (the agent's thumbs-up / thumbs-down) | `.lodestone/lodestone.sqlite` (`feedback` table) | Same |
| Watcher state, ready marker | `.lodestone/runtime/`, `.lodestone/ready.json` | Same |

## What leaves the machine

In friend mode, **nothing** leaves the machine at runtime for the packaged `lite` and `full` profiles. Once installed, Lodestone runs entirely offline. A consent-gated model setup path is reserved for future releases, but the public v0.1.x build keeps it fail-closed until real release pins are published.

The two scenarios where bytes might leave your machine are:

1. **Installing or upgrading Lodestone itself.** The friend installer downloads pinned Lodestone release tarballs from GitHub and lets npm resolve normal package dependencies. Future npm-published paths will hit the public npm registry. This is normal package installation traffic, not runtime code upload.
2. **Future consent-gated model setup.** The `lodestone setup-models --allow-download` command is the reserved path for pinned, operator-approved model downloads. In the public v0.1.x friend build it exits before any network call because the built-in live-fetch manifest intentionally has placeholder hashes. The packaged `lite` and `full` friend profiles already bundle their model weights, so normal friend runtime does not need this fetch.

That is the complete list. There is no third path.

## The `LODESTONE_OFFLINE=1` guard

If you want a hard guarantee, set `LODESTONE_OFFLINE=1` in your shell or in your editor's MCP config. This wires the chokepoint in `@lodestone/shared/net/fetch`: every outbound network call inside the Lodestone process passes through `assertNetworkAllowed()`, which throws `NetworkBlockedError` (with the call site named) when offline mode is active. Embedder fetches, model downloads, anything — they all go through this gate. Once on, network calls are not silently degraded; they fail loudly with a message naming the caller.

`lodestone doctor` reports the current offline-mode status so you can verify it without restarting your editor.

## The opt-in `setup-models` path

There is exactly one runtime-fetch path Lodestone reserves for friends, and it is gated by **two** consents that both have to say yes. In the public v0.1.x friend build, the command also has a release-pin gate and exits before network because live fetch pins are not published yet:

```bash
# Public v0.1.x behavior: refuses before any network call because live
# setup-models pins are not published yet.
lodestone setup-models --embedder nomic-text-v1.5
# → exits non-zero with "setup-models is not enabled in this public v0.1.x build"

# Future pinned build, opt in explicitly:
lodestone setup-models --embedder nomic-text-v1.5 --allow-download
# → public v0.1.x: exits before network because live setup-models pins
#   are not published yet.
# → future pinned build: still hits assertNetworkAllowed("setup-models: ...")
#   and so still fails when LODESTONE_OFFLINE=1.
```

The two gates:

1. **Operator opt-in.** The `--allow-download` flag (or the equivalent `LODESTONE_ALLOW_MODEL_DOWNLOAD=1` env var) — the friend has to say "yes, fetch this." Without it, the command refuses.
2. **Repo-wide chokepoint.** `assertNetworkAllowed("setup-models: <id>")` from `@lodestone/shared/net/fetch`. When `LODESTONE_OFFLINE=1` is set anywhere in the environment, this throws — the operator opt-in is overridden by the offline guard.

This is the only deliberate path that may touch the network at runtime once real pins ship. Weights land per-project at `<repoRoot>/.lodestone/models/<id>/`, never in a shared global cache, so one friend's `setup-models` cannot leak weights into another friend's project.

The implementation lives in `packages/cli/src/commands/setup-models.ts`. The full list of URLs `setup-models` is permitted to contact is in [`network-manifest.json`](../network-manifest.json) at the repo root.

## The build-time grep audit

We enforce the "no outbound URLs" claim at release time, not just at runtime. Every CI build runs a grep over the shipped `dist/` directory looking for `https://` URLs. Any URL that appears must be on a documented allowlist; anything new fails the build.

The allowlist lives in two places that have to agree:

- [`network-manifest.json`](../network-manifest.json) at the repo root — the human-readable, reviewer-facing list of every URL pattern Lodestone is allowed to contact at install, build, or setup time, paired with the chokepoint that gates each one.
- `packages/shared/src/net/__tests__/no-outbound-urls.test.ts` — the machine-readable allowlist consumed by the audit. Every entry carries a `reason` field. The test walks every shipped `dist/` directory, regex-matches every `http(s)://` literal, and fails on anything not on the list.

Today the allowlist is:

- `https://registry.npmjs.org/` — the npm registry, used only by `npm install` / `pnpm install` itself, not by the running tool.
- `https://huggingface.co/Xenova/nomic-embed-text-v1.5/` — reserved for the future opt-in `setup-models` path above; the public v0.1.x build fails closed before reaching it.
- `https://huggingface.co/Snowflake/snowflake-arctic-embed-s/` — reserved for the future opt-in `setup-models` path above; the public v0.1.x build fails closed before reaching it.
- `https://huggingface.co/nomic-ai/`, `https://huggingface.co/ibm-granite/` — pre-approved maintainer orgs reserved for future bundled embedder variants. Currently unused in code; pre-listing them means the §05 / §10 follow-on work does not have to amend the manifest at the same time as it ships code.
- `https://spdx.org/licenses/` — license-identifier comment root. Inert, never contacted at runtime.

The audit runs in two places, both as gates:

1. **Locally**, inside `pnpm -r test` — every developer hits it before pushing.
2. **In CI**, as a dedicated `Privacy audit — no outbound URLs in dist/` step inside `.github/workflows/ci.yml`. The step exists separately from the bulk test run so the privacy claim shows up as its own named check on every PR. If you ever see a Lodestone release that has more URLs in its dist than the allowlist, treat it as a bug and file an issue.

## No telemetry

There is no telemetry. No usage events, no error reports, no anonymous metrics. The closest thing is the `feedback` MCP tool, which the agent calls voluntarily after a useful or unhelpful tool call — but those events are written to your local `.lodestone/lodestone.sqlite` and stay there. Nothing is sent anywhere.

## Verifying offline behavior locally

```bash
# Confirm the runtime guard is active.
LODESTONE_OFFLINE=1 lodestone doctor

# Try forcing a fetch under the guard. The tiny profile is the only path that
# would normally fetch; with OFFLINE=1 it should fail loudly with a clear error.
LODESTONE_OFFLINE=1 lodestone reindex --profile tiny --from-scratch
```

You can also confirm by network observation: watch your firewall or run `lodestone init && lodestone reindex` under `strace -e trace=network` (Linux) or Little Snitch (macOS) and you will see no outbound traffic on the default profile.

<!-- SPDX-License-Identifier: Apache-2.0 -->

# Known issues

Open issues carried for the v0.1.x line, with impact assessment and workaround notes. Anything genuinely blocking would hold the release.

## Production dependency audit status

As of the v0.1.5 friend-install release prep on 2026-06-08, `pnpm audit --prod` is clean after root-level package overrides for patched transitive releases of `hono`, `ip-address`, `protobufjs`, and `qs`.

Because registry advisories can change after a release, treat `pnpm audit --prod` as a live verification command rather than a permanent guarantee.

## Cosmetic items from the §20 e2e pass

The end-to-end test pass surfaced a small handful of cross-section cleanups (parser edge resolution edge cases, `LODESTONE_DB_PATH` env-var alignment, init/reindex command split). These do not affect correctness on the happy path; they are tracked in the section §22 backlog and will land in v0.1.x patch releases.

## v0 has no migration runner

By design, not a bug — see [`UPGRADE.md`](./UPGRADE.md). Schema bumps within v0.x require `lodestone reindex --from-scratch`. The numbered-migrations runner ships in v0.5 alongside the embedder-dim swap option.

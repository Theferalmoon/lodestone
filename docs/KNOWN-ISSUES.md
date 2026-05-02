<!-- SPDX-License-Identifier: Apache-2.0 -->

# Known issues

Open issues at v0.1.0 ship time, with the impact assessment and the workaround. Anything genuinely blocking would have held the ship; this is the list of things that are real but tolerable for a v0.

## Transitive CVE in `protobufjs` via `@xenova/transformers`

The bundled embedder pulls `@xenova/transformers > onnxruntime-web > onnx-proto > protobufjs` and the deeply-nested `protobufjs` is below the `<7.5.5` patched range for **GHSA-xq3m-2v4x-88gg** (a prototype-pollution issue in the protobuf parser).

**Impact on Lodestone:** none on the runtime path. The protobuf code in this dep tree is only exercised by ONNX Runtime when loading model files, and Lodestone's bundled weights are pinned + integrity-checked + loaded from inside the package itself (not from attacker-influenced input). The CVE requires attacker-controlled protobuf input to trigger.

**Workaround:** none required for normal use. We are tracking the upstream pin bump and will publish a Lodestone patch release once the chain is patched. If your security team requires a clean `pnpm audit`, the only affected workflow is `pnpm audit` itself; runtime is not affected.

**Fix tracked at:** upstream issue in the `@xenova/transformers` repository.

## Cosmetic items from the §20 e2e pass

The end-to-end test pass surfaced a small handful of cross-section cleanups (parser edge resolution edge cases, `LODESTONE_DB_PATH` env-var alignment, init/reindex command split). These do not affect correctness on the happy path; they are tracked in the section §22 backlog and will land in v0.1.x patch releases.

## v0 has no migration runner

By design, not a bug — see [`UPGRADE.md`](./UPGRADE.md). Schema bumps within v0.x require `lodestone reindex --from-scratch`. The numbered-migrations runner ships in v0.5 alongside the embedder-dim swap option.

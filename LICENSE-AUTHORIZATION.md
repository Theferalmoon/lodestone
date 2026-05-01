# LICENSE AUTHORIZATION

---

## Authorization

I, **Theferalmoon** (sole author and copyright holder of the CMNDI codebase, an internal monorepo authored by me and not redistributed), hereby authorize the relicensing under the **Apache License, Version 2.0** of the algorithmic core of the following components, as they are extracted into the Lodestone distribution:

- `cmndi-flywheel/` — the ingestion pipeline + training queue (the algorithmic core, excluding the CMNDI-specific Captain's Log, Locksmith, CMDB, IAM, mTLS, and TLS startup-chain integrations which are not extracted)
- `cmndi-clusterer/` — the Leiden community detection and cluster naming heuristic (algorithm + heuristics; the cluster naming logic and short-content penalty are inspired-by, with an explicit clean-room rewrite for Lodestone v0)
- `cmndi-skill-emitter/` — the cluster → SKILL.md emitter (selection gating, archive logic, frontmatter rendering, idempotency by SHA256)
- `cmndi-context-engine/` — the RAG search service core (retrieval logic, query embedding, ranking — excluding the CMNDI-specific mandate collection)
- `cmnd-embed-home/` — the FastAPI embedder service (HTTP shape, model-loader plumbing, Prometheus metrics — excluding any CMNDI-specific compliance headers)

**Apache 2.0 SPDX headers are valid in the extracted Lodestone files** because the rights holder (signed below) has authorized the relicensing.

This authorization explicitly covers:

- Copying or porting the algorithmic logic of the above components into the Lodestone distribution.
- Replacing the original source-file headers (which carry CMNDI-specific compliance language and any AGPL or other notices) with the standard Apache 2.0 SPDX header (`// SPDX-License-Identifier: Apache-2.0`) plus a one-line description.
- Subsequent modifications, derivatives, and forks of the Lodestone distribution under Apache 2.0 by any party.

This authorization does **not**:

- Relicense the original CMNDI source repository. The CMNDI repository (an internal monorepo) continues under whatever license(s) it carries today, which may be different from Apache 2.0.
- Authorize the relicensing of any CMNDI-internal infrastructure that is NOT extracted into Lodestone (Captain's Log, Locksmith, OpenBao, IAM, Cartographer/SkyMesh PQC mesh, CMDB, USG/HAL/golf-os SaaS, DAIV branding, compliance framework integrations).
- Convey trademark rights to the "CMNDI" or "DAIV" names or marks.

---

## Why this document exists

A second-pair-of-eyes architecture review (Codex round 001, recorded at `docs/codex-review/lodestone/001-result.md`) identified that "replace AGPL headers with Apache headers" was named in the original plan as an implementation step without an explicit authorization record. Codex correctly noted that header replacement alone is not legally valid relicensing — only the rights holder may authorize the change.

This document **is** that authorization. It is committed to the Lodestone repository at the root so that any future contributor, downstream user, or auditor can verify provenance.

---

## Signature

**Rights holder:** Theferalmoon (sole copyright holder, CMNDI codebase)

**Date authorized:** 2026-05-01

**Recorded in commit:** see `git log` for the landing commit (this file is committed at the root of the lodestone repo).

**Witness reference:** see the §6 "Relicensing" section of the Lodestone v0 implementation plan, recorded as `claude-integration-notes-codex-001.md` in the planning artifacts that accompany this distribution. The internal CMNDI source location is intentionally not disclosed in this public-facing document.

---

## For downstream users

Lodestone is distributed under the Apache License, Version 2.0. See `LICENSE` at the repo root for the full license text. This file (`LICENSE-AUTHORIZATION.md`) records the rights-holder authorization that makes the Apache 2.0 distribution legally valid given the source provenance described above.

You do NOT need to do anything with this file. It is documentary only. The license that governs your use of Lodestone is `LICENSE` (Apache 2.0), full stop.

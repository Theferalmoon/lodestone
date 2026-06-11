<!-- SPDX-License-Identifier: Apache-2.0 -->

# Lodestone Roadmap

This roadmap separates the friend distribution from Pro work. The v0.1.x friend
installer stays simple: one repository, one local SQLite index, bundled
embedders, no runtime code upload, and no external service.

## Friend Distribution

Friend mode remains the default public install path.

- One repository per install.
- One current-state local knowledge graph under `.lodestone/`.
- Git-aware `recent_changes` over the current index.
- Lite and full bundled-model profiles.
- No temporal graph history.
- No multi-repo orchestration.
- No shared service requirement.

The friend distribution should stay easy to install, easy to uninstall, and
small enough to support without turning every friend repo into a Pro deployment.

## Pro Temporal KG

Temporal KG support belongs in Pro. It should not ship in friend mode until the
storage model, migrations, retention policy, and query semantics are complete.

The Pro temporal KG should include:

- Node and edge history.
- Index-run records tied to git commits and wall-clock time.
- Graph snapshots or reconstructable graph state.
- "As of commit/date" graph queries.
- "Changed between A and B" graph diffs.
- Retention and pruning controls.
- Clear provenance in every MCP response that uses historical state.

Current v0.1.x builds reserve `pro.temporal_kg_enabled`, but accept only
`false`. Setting it to `true` is rejected so friend installs fail closed instead
of silently pretending historical graph storage exists.

## Guardrail

Do not add temporal KG storage, migrations, or MCP tools to the friend installer
as a partial feature. Friend mode may keep improving current-state KG quality,
but historical graph semantics are a Pro product boundary.

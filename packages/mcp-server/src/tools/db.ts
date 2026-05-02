// SPDX-License-Identifier: Apache-2.0
// Lodestone MCP — DB-path resolver shim. POST-§20 (Issue B): the actual
// resolver moved to `_shared.ts` so §14 search tools and §15 graph tools
// share one precedence chain. This module re-exports the consolidated
// surface for back-compat — any importer that previously pulled from
// `./db.js` (the §15 unit tests, primarily) keeps working unchanged.
//
// New code should import directly from `./_shared.js`.
//
// Compliance: NIST 800-53 AC-3 (Access Enforcement — read-only handle),
// AC-6 (Least Privilege — single resolver path), SI-7 (Software & Information
// Integrity — single source of truth), SC-28 (Protection at Rest); CMMC L2
// AC.L2-3.1.5; SOC 2 CC6.1; ISO 27001 A.9.4.1; FedRAMP Mod AC-6;
// CIS v8 Control 6.8 (least privilege).
export {
  _setTestDbPath,
  openProjectReader,
  resolveDbPath,
} from "./_shared.js";

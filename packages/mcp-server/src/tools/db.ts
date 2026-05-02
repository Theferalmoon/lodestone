// SPDX-License-Identifier: Apache-2.0
// Lodestone MCP — shared SQLite reader resolution for §15 graph tools.
//
// Compliance: NIST 800-53 AC-3 (Access Enforcement — read-only handle),
// AC-6 (Least Privilege — defense-in-depth via OPEN_READONLY at the driver),
// SI-7 (Software & Information Integrity — single resolver path), SC-28
// (Protection of Information at Rest — no writes possible from this surface);
// CMMC L2 AC.L2-3.1.5; SOC 2 CC6.1; ISO 27001 A.9.4.1; FedRAMP Mod AC-6;
// CIS v8 Control 6.8 (least privilege).
//
// Why this file exists: handler signatures in §13 are `(input: unknown) =>
// Promise<LodestoneToolResponseV13<unknown>>` — there is no DB injection
// channel. Each handler must resolve its own read-only handle on call. To
// keep tests sane (and to make the handler unit-testable WITHOUT spinning
// up a full server), this module accepts an explicit override path via
// `LODESTONE_DB_PATH` env var (set by the §13 main() entrypoint) AND
// supports a `resolveDbPath` argument so test harnesses can point handlers
// at a temp DB directly. When neither is set, falls back to
// `<cwd>/.lodestone/lodestone.sqlite` per @lodestone/shared canonical paths.

import { lodestoneSubpath } from "@lodestone/shared";

import { openReader, type ReaderHandle } from "../client/sqlite.js";

/**
 * Module-level override for unit tests. Setting this short-circuits all
 * other resolution. Cleared by tests in afterEach.
 */
let testOverridePath: string | null = null;

/**
 * Test-only: pin the resolver to a specific db path. Production code never
 * calls this — only the §15 handler unit tests do.
 */
export function _setTestDbPath(path: string | null): void {
  testOverridePath = path;
}

/**
 * Resolve the project SQLite db path using the documented precedence:
 *   1. test override (set via _setTestDbPath)
 *   2. LODESTONE_DB_PATH env var (set by server main entrypoint)
 *   3. <cwd>/.lodestone/lodestone.sqlite (canonical path resolver)
 */
export function resolveDbPath(): string {
  if (testOverridePath !== null) return testOverridePath;
  const envPath = process.env.LODESTONE_DB_PATH;
  if (envPath && envPath.length > 0) return envPath;
  return lodestoneSubpath(process.cwd(), "sqlite");
}

/**
 * Open a read-only handle to the project SQLite index. Wraps openReader from
 * client/sqlite.ts; centralized here so every §15 handler shares one resolver
 * and one error surface. Caller MUST close the handle (use try/finally).
 */
export function openProjectReader(): ReaderHandle {
  return openReader(resolveDbPath());
}

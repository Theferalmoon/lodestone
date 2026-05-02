// SPDX-License-Identifier: Apache-2.0
//
// Section 18 / Codex impl-005 amendment — shared SHA256 verification
// helper. Single source of truth for "compute sha256 of a file on disk"
// so every callsite (setup-models, snowflake fallback, future bundler
// digest pinning) verifies against the same reference implementation.
//
// Design choices:
//   - Synchronous `readFileSync` because both current callers buffer the
//     ~138 MB nomic int8 model fine inside the cli + ingest processes.
//     If a later caller needs streaming, add `sha256FileStream` here
//     rather than splitting the impl across packages.
//   - Lowercase hex output. All pin manifests + tests assume lowercase
//     hex — case mismatch would silently fail digest comparisons.
//
// Compliance: NIST 800-53 SI-7 (Software/Firmware Integrity), SC-13
// (Cryptographic Protection), CM-5 (Access Restrictions for Change);
// CMMC L2 SI.L2-3.14.1; SOC 2 CC7.2; ISO 27001 A.12.5.1; FedRAMP
// Moderate SI-7.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Compute the lowercase-hex SHA256 of a file on disk.
 *
 * Throws if the file does not exist or cannot be read — callers are
 * expected to gate this behind an `existsSync()` check or a try/catch
 * that maps the failure to their domain error type (e.g. the snowflake
 * loader maps to `EmbedderLoadError`).
 */
export function sha256File(filePath: string): string {
  const buf = readFileSync(filePath);
  return createHash("sha256").update(buf).digest("hex");
}

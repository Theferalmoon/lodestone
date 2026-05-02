// SPDX-License-Identifier: Apache-2.0
//
// Section 18 — privacy enforcement chokepoint.
//
// `assertNetworkAllowed(reason)` is the SINGLE runtime gate every Lodestone
// package MUST call before initiating any outbound network I/O. When
// `LODESTONE_OFFLINE=1` is set in the environment, the call throws a
// `NetworkBlockedError` whose message includes the supplied `reason` so the
// friend can immediately see what tried to call out.
//
// The friend-product privacy promise — "your code never leaves your
// machine" — is enforced here. Section 18 also adds a build-time grep audit
// over compiled `dist/` artifacts that confirms no unexpected outbound URL
// literals slip through, but the runtime gate is the load-bearing piece for
// any code path that runs in friend mode.
//
// Compliance: NIST 800-53 SC-7 (Boundary Protection), CM-7 (Least
// Functionality), AC-3 (Access Enforcement); CMMC L2 SC.L2-3.13.5;
// SOC 2 CC6.6; ISO 27001 A.13.1.1; FedRAMP Moderate SC-7.

/**
 * Thrown when an outbound network call is attempted while
 * `LODESTONE_OFFLINE=1` is in effect. The error message names the calling
 * site (`reason`) so the friend can identify and audit the offending path.
 */
export class NetworkBlockedError extends Error {
  /** Stable identifier for catch-side discrimination. */
  public readonly code: "LODESTONE_OFFLINE_BLOCKED" = "LODESTONE_OFFLINE_BLOCKED";

  constructor(public readonly reason: string) {
    super(
      `Network call blocked by LODESTONE_OFFLINE=1 (reason: ${reason}). ` +
        `Unset LODESTONE_OFFLINE (or set it to "0") to allow the call. ` +
        `See docs/PRIVACY.md for the full privacy contract.`
    );
    this.name = "NetworkBlockedError";
  }
}

/**
 * Returns `true` when `LODESTONE_OFFLINE` is set to the literal string `"1"`
 * (the canonical opt-in for friend offline mode). Any other value — unset,
 * `"0"`, `"true"`, etc. — returns `false`. We intentionally accept ONLY `"1"`
 * to match every other CMNDI offline-mode flag and to give friends a single
 * unambiguous incantation.
 */
export function isOfflineMode(): boolean {
  return process.env.LODESTONE_OFFLINE === "1";
}

/**
 * The chokepoint. Every code path that initiates outbound network I/O — HF
 * model fetch, npm registry self-update, any future HTTPS call — MUST call
 * this first with a short, human-readable `reason` describing the call site.
 *
 * Throws `NetworkBlockedError` when offline mode is active.
 *
 * Examples of valid reasons:
 *   - "snowflake fallback weights"
 *   - "lodestone upgrade self-update via registry.npmjs.org"
 *
 * The reason is surfaced in the thrown error message AND is the audit-log
 * trail when Section 18's runtime fetch wrapper logs a denied call.
 */
export function assertNetworkAllowed(reason: string): void {
  if (typeof reason !== "string" || reason.length === 0) {
    throw new TypeError(
      "assertNetworkAllowed requires a non-empty reason string for the audit trail"
    );
  }
  if (isOfflineMode()) {
    throw new NetworkBlockedError(reason);
  }
}

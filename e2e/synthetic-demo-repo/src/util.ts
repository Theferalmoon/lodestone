// SPDX-License-Identifier: Apache-2.0
// Shared utilities used across the synthetic demo repo. Logging + error
// hierarchy + helpers — these symbols should appear in any clusterer run as
// either bridges (cross-cluster) or members of a "shared" cluster.

/** Custom-error family. Each subclass extends the JS root `Error` directly so
 * the §11 error-hierarchy seed-skill scanner sees ≥2 classes whose base_name
 * matches a known error root and emits the seed skill. (AppError stays as a
 * convenience wrapper with `code` but is also root-derived.) */
export class AppError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "AppError";
  }
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export class DbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DbError";
  }
}

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

/** Lightweight logger — referenced by every other TS module so it shows up as
 * a high-PageRank "bridge" symbol across all subsystems. */
export function log(scope: string, message: string): void {
  // Intentionally trivial; we only need the symbol + edges for the e2e.
  process.stdout.write(`[${scope}] ${message}\n`);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function assertNonEmpty(value: string, name: string): void {
  if (value.length === 0) {
    throw new AppError(`${name} must be non-empty`, "VALIDATION");
  }
}

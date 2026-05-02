// SPDX-License-Identifier: Apache-2.0
// `since` filter parser for section 14 search tools.
//
// The `since` field accepts three input shapes:
//   1. A git commit hash — interpreted as "results changed AFTER this commit".
//   2. An ISO-8601 timestamp — wall-clock cutoff; only commits at-or-after.
//   3. A relative duration string ("1 week ago", "24h", "2w") — converted to
//      an absolute cutoff = now - duration.
//
// Malformed input throws `MalformedSinceError`. Callers should turn that into
// a wrapErr() envelope so the agent sees a clear validation failure rather
// than an empty result list.
//
// This module is intentionally git-aware in spec but git-free in this file:
// resolution of commit-hash to timestamp happens inside the tool handler with
// access to the repo path. Here we only classify + parse.

/** Classifier output. The shape carries everything the caller needs to apply
 * the filter: a kind discriminator + the parsed value. */
export type SinceSpec =
  | { kind: "commit"; hash: string }
  | { kind: "timestamp"; epochMs: number }
  | { kind: "relative"; epochMs: number; rawDuration: string };

export class MalformedSinceError extends Error {
  constructor(input: string, reason: string) {
    super(
      `Malformed \`since\` value ${JSON.stringify(input)}: ${reason}. ` +
        `Accepted forms: a git commit hash (e.g. "abc1234"), an ISO-8601 ` +
        `timestamp (e.g. "2026-04-01T00:00:00Z"), or a relative duration ` +
        `(e.g. "1 week ago", "3 days ago", "24h").`,
    );
    this.name = "MalformedSinceError";
  }
}

/** Compiled regexes — module-load constants so we do not pay parse cost
 * per request. */
const HEX_HASH_RE = /^[0-9a-f]{4,40}$/i;
const RELATIVE_NL_RE =
  /^(\d+)\s*(second|seconds|sec|secs|s|minute|minutes|min|mins|m|hour|hours|hr|hrs|h|day|days|d|week|weeks|w|month|months|mo|year|years|y)\s*(ago)?$/i;
const RELATIVE_COMPACT_RE = /^(\d+)\s*(s|m|h|d|w|mo|y)$/i;

const UNIT_TO_MS: Record<string, number> = {
  s: 1000,
  sec: 1000,
  secs: 1000,
  second: 1000,
  seconds: 1000,
  m: 60 * 1000,
  min: 60 * 1000,
  mins: 60 * 1000,
  minute: 60 * 1000,
  minutes: 60 * 1000,
  h: 60 * 60 * 1000,
  hr: 60 * 60 * 1000,
  hrs: 60 * 60 * 1000,
  hour: 60 * 60 * 1000,
  hours: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  days: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  weeks: 7 * 24 * 60 * 60 * 1000,
  mo: 30 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
  months: 30 * 24 * 60 * 60 * 1000,
  y: 365 * 24 * 60 * 60 * 1000,
  year: 365 * 24 * 60 * 60 * 1000,
  years: 365 * 24 * 60 * 60 * 1000,
};

/**
 * Parse a `since` input string into one of the three spec shapes.
 *
 * Resolution order:
 *   1. Commit-hash regex first.
 *   2. Relative-duration regex second (so "1 day ago" does not fall through
 *      to Date.parse, which would NaN it).
 *   3. ISO-8601 timestamp last (Date.parse is lenient and over-accepts).
 *
 * `nowMs` is injectable for deterministic tests of the relative-duration path.
 */
export function parseSince(
  input: string,
  nowMs: number = Date.now(),
): SinceSpec {
  if (typeof input !== "string") {
    throw new MalformedSinceError(String(input), "must be a string");
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new MalformedSinceError(input, "empty string");
  }

  // (1) commit hash — must be only hex chars, length 4-40.
  if (HEX_HASH_RE.test(trimmed)) {
    return { kind: "commit", hash: trimmed.toLowerCase() };
  }

  // (2) relative duration — natural-language ("1 week ago") or compact ("24h").
  const nlMatch = RELATIVE_NL_RE.exec(trimmed);
  const compactMatch = nlMatch ? null : RELATIVE_COMPACT_RE.exec(trimmed);
  const match = nlMatch ?? compactMatch;
  if (match) {
    const count = Number.parseInt(match[1] ?? "0", 10);
    const unit = (match[2] ?? "").toLowerCase();
    const ms = UNIT_TO_MS[unit];
    if (!Number.isFinite(count) || count < 0 || ms === undefined) {
      throw new MalformedSinceError(input, `unrecognised duration unit "${unit}"`);
    }
    return {
      kind: "relative",
      epochMs: nowMs - count * ms,
      rawDuration: trimmed,
    };
  }

  // (3) ISO-8601 timestamp. We require at least YYYY-MM-DD; bare numbers like
  // "20260401" silently parse via Date.parse but are almost certainly user
  // error, so we reject anything without a `-`.
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    const epochMs = Date.parse(trimmed);
    if (!Number.isFinite(epochMs)) {
      throw new MalformedSinceError(input, "not a valid ISO-8601 timestamp");
    }
    return { kind: "timestamp", epochMs };
  }

  throw new MalformedSinceError(
    input,
    "did not match commit-hash, ISO-8601 timestamp, or relative-duration shape",
  );
}

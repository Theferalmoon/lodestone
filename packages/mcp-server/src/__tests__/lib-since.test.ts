// SPDX-License-Identifier: Apache-2.0
// parseSince() — section 14 RED #3 helper. Verifies the three input shapes
// (commit hash / ISO timestamp / relative duration) classify correctly and
// that malformed input throws a typed error.

import { describe, expect, it } from "vitest";

import { MalformedSinceError, parseSince } from "../lib/since.js";

describe("parseSince — commit-hash shape", () => {
  it("classifies a 7-char hex string as commit", () => {
    const r = parseSince("abc1234");
    expect(r.kind).toBe("commit");
    if (r.kind === "commit") expect(r.hash).toBe("abc1234");
  });

  it("classifies a 40-char hex string as commit", () => {
    const hash = "abcdef0123456789abcdef0123456789abcdef01";
    const r = parseSince(hash);
    expect(r.kind).toBe("commit");
    if (r.kind === "commit") expect(r.hash).toBe(hash);
  });

  it("normalises the hash to lowercase", () => {
    const r = parseSince("ABCDEF1");
    expect(r.kind).toBe("commit");
    if (r.kind === "commit") expect(r.hash).toBe("abcdef1");
  });

  it("rejects a 3-char hex (too short to be unambiguous)", () => {
    expect(() => parseSince("abc")).toThrow(MalformedSinceError);
  });
});

describe("parseSince — relative-duration shape", () => {
  const NOW = Date.parse("2026-05-02T12:00:00Z");

  it("parses '1 week ago'", () => {
    const r = parseSince("1 week ago", NOW);
    expect(r.kind).toBe("relative");
    if (r.kind === "relative") {
      expect(r.epochMs).toBe(NOW - 7 * 24 * 60 * 60 * 1000);
    }
  });

  it("parses '3 days ago'", () => {
    const r = parseSince("3 days ago", NOW);
    if (r.kind === "relative") {
      expect(r.epochMs).toBe(NOW - 3 * 24 * 60 * 60 * 1000);
    } else {
      throw new Error("expected relative");
    }
  });

  it("parses compact '24h'", () => {
    const r = parseSince("24h", NOW);
    if (r.kind === "relative") {
      expect(r.epochMs).toBe(NOW - 24 * 60 * 60 * 1000);
    } else {
      throw new Error("expected relative");
    }
  });

  it("parses compact '2w'", () => {
    const r = parseSince("2w", NOW);
    if (r.kind === "relative") {
      expect(r.epochMs).toBe(NOW - 14 * 24 * 60 * 60 * 1000);
    } else {
      throw new Error("expected relative");
    }
  });

  it("parses '14 days' without 'ago'", () => {
    const r = parseSince("14 days", NOW);
    if (r.kind === "relative") {
      expect(r.epochMs).toBe(NOW - 14 * 24 * 60 * 60 * 1000);
    } else {
      throw new Error("expected relative");
    }
  });
});

describe("parseSince — ISO-8601 shape", () => {
  it("parses 'YYYY-MM-DD'", () => {
    const r = parseSince("2026-04-01");
    expect(r.kind).toBe("timestamp");
    if (r.kind === "timestamp") {
      expect(r.epochMs).toBe(Date.parse("2026-04-01"));
    }
  });

  it("parses a full ISO timestamp", () => {
    const r = parseSince("2026-04-01T12:00:00Z");
    if (r.kind === "timestamp") {
      expect(r.epochMs).toBe(Date.parse("2026-04-01T12:00:00Z"));
    } else {
      throw new Error("expected timestamp");
    }
  });

  it("classifies bare 8-digit '20260401' as commit (hex), not ISO date", () => {
    // An 8-character all-digit string is a valid abbreviated git hash. We
    // intentionally classify it as commit so the parser is unambiguous;
    // callers who meant "2026-04-01" must include the dashes.
    const r = parseSince("20260401");
    expect(r.kind).toBe("commit");
  });
});

describe("parseSince — malformed input", () => {
  it("throws on empty string", () => {
    expect(() => parseSince("")).toThrow(MalformedSinceError);
  });

  it("throws on whitespace-only", () => {
    expect(() => parseSince("   ")).toThrow(MalformedSinceError);
  });

  it("throws on garbage", () => {
    expect(() => parseSince("yesterday-ish")).toThrow(MalformedSinceError);
  });

  it("error message references the accepted shapes", () => {
    try {
      parseSince("???");
      throw new Error("did not throw");
    } catch (err) {
      expect((err as Error).message).toMatch(/commit hash/);
      expect((err as Error).message).toMatch(/ISO/);
      expect((err as Error).message).toMatch(/relative/);
    }
  });
});

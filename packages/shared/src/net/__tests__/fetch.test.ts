// SPDX-License-Identifier: Apache-2.0
// Section 18 — runtime offline-guard tests.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertNetworkAllowed,
  isOfflineMode,
  NetworkBlockedError,
} from "../fetch.js";

describe("assertNetworkAllowed", () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env.LODESTONE_OFFLINE;
    delete process.env.LODESTONE_OFFLINE;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.LODESTONE_OFFLINE;
    else process.env.LODESTONE_OFFLINE = original;
  });

  it("does NOT throw when LODESTONE_OFFLINE is unset", () => {
    expect(() => assertNetworkAllowed("test reason")).not.toThrow();
  });

  it("does NOT throw when LODESTONE_OFFLINE is the literal string '0'", () => {
    process.env.LODESTONE_OFFLINE = "0";
    expect(() => assertNetworkAllowed("test reason")).not.toThrow();
  });

  it("does NOT throw when LODESTONE_OFFLINE is set to a non-canonical truthy value (e.g. 'true')", () => {
    // We accept ONLY the literal "1" to give friends a single unambiguous
    // incantation. "true" is not it.
    process.env.LODESTONE_OFFLINE = "true";
    expect(() => assertNetworkAllowed("test reason")).not.toThrow();
  });

  it("throws NetworkBlockedError when LODESTONE_OFFLINE='1'", () => {
    process.env.LODESTONE_OFFLINE = "1";
    expect(() => assertNetworkAllowed("snowflake fallback weights")).toThrow(
      NetworkBlockedError
    );
  });

  it("error message includes the supplied reason and the offline env var name", () => {
    process.env.LODESTONE_OFFLINE = "1";
    try {
      assertNetworkAllowed("snowflake fallback weights");
      expect.unreachable("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkBlockedError);
      const e = err as NetworkBlockedError;
      expect(e.message).toContain("LODESTONE_OFFLINE");
      expect(e.message).toContain("snowflake fallback weights");
      expect(e.message).toContain("PRIVACY.md");
      expect(e.reason).toBe("snowflake fallback weights");
      expect(e.code).toBe("LODESTONE_OFFLINE_BLOCKED");
    }
  });

  it("rejects an empty reason at the chokepoint (TypeError, NOT a network block)", () => {
    expect(() => assertNetworkAllowed("")).toThrow(TypeError);
  });

  it("rejects a non-string reason", () => {
    // @ts-expect-error — explicit type-violation under test
    expect(() => assertNetworkAllowed(undefined)).toThrow(TypeError);
  });
});

describe("isOfflineMode", () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env.LODESTONE_OFFLINE;
    delete process.env.LODESTONE_OFFLINE;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.LODESTONE_OFFLINE;
    else process.env.LODESTONE_OFFLINE = original;
  });

  it("returns false when unset", () => {
    expect(isOfflineMode()).toBe(false);
  });

  it("returns true ONLY for the literal string '1'", () => {
    process.env.LODESTONE_OFFLINE = "1";
    expect(isOfflineMode()).toBe(true);
  });

  it("returns false for '0'", () => {
    process.env.LODESTONE_OFFLINE = "0";
    expect(isOfflineMode()).toBe(false);
  });

  it("returns false for 'true' (only '1' counts)", () => {
    process.env.LODESTONE_OFFLINE = "true";
    expect(isOfflineMode()).toBe(false);
  });
});

describe("NetworkBlockedError", () => {
  it("has name='NetworkBlockedError' for catch-by-name discrimination", () => {
    const e = new NetworkBlockedError("some path");
    expect(e.name).toBe("NetworkBlockedError");
  });

  it("preserves the reason as a public field", () => {
    const e = new NetworkBlockedError("reason-x");
    expect(e.reason).toBe("reason-x");
  });

  it("is an instance of Error", () => {
    expect(new NetworkBlockedError("x")).toBeInstanceOf(Error);
  });
});

// SPDX-License-Identifier: Apache-2.0
// Envelope wrapper tests — request_id generation, channel validation, helpers.
import { describe, it, expect } from "vitest";

import {
  LODESTONE_CHANNEL_V0,
  ChannelValidationError,
  validateChannel,
  wrapOk,
  wrapErr,
  wrapNotImplemented,
  wrapNotReady,
  NOT_READY_PROVENANCE,
  emptyDiagnostics,
} from "../envelope.js";

const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("validateChannel (POST-FORGE-VISION amendment §2)", () => {
  it("accepts the literal 'code' channel", () => {
    expect(validateChannel("code")).toBe("code");
  });

  it("accepts undefined and null (back-compat — defaults to 'code')", () => {
    expect(validateChannel(undefined)).toBe("code");
    expect(validateChannel(null)).toBe("code");
  });

  it("rejects 'ops' with a clear error mentioning Forge channels", () => {
    expect(() => validateChannel("ops")).toThrow(ChannelValidationError);
    try {
      validateChannel("ops");
    } catch (err) {
      expect((err as Error).message).toMatch(/v0 only accepts channel="code"/);
      expect((err as Error).message).toMatch(/Forge channels.*reserved/);
    }
  });

  it("rejects 'training' (also reserved for Forge v1)", () => {
    expect(() => validateChannel("training")).toThrow(ChannelValidationError);
  });

  it("rejects arbitrary strings", () => {
    expect(() => validateChannel("foo")).toThrow(ChannelValidationError);
    expect(() => validateChannel("")).toThrow(ChannelValidationError);
  });

  it("rejects non-string values (number, object, boolean)", () => {
    expect(() => validateChannel(42)).toThrow(ChannelValidationError);
    expect(() => validateChannel({ channel: "code" })).toThrow(ChannelValidationError);
    expect(() => validateChannel(true)).toThrow(ChannelValidationError);
  });

  it("ChannelValidationError carries the received string when string-typed", () => {
    try {
      validateChannel("ops");
    } catch (err) {
      expect((err as ChannelValidationError).received).toBe("ops");
    }
  });
});

describe("wrapOk", () => {
  it("produces a v13 envelope with channel='code'", () => {
    const env = wrapOk([{ id: 1 }], LODESTONE_CHANNEL_V0);
    expect(env.channel).toBe("code");
    expect(env.results).toEqual([{ id: 1 }]);
  });

  it("generates a UUID v7 request_id", () => {
    const env = wrapOk<unknown>([], LODESTONE_CHANNEL_V0);
    expect(env.request_id).toMatch(UUID_V7_PATTERN);
  });

  it("each call yields a unique request_id", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      ids.add(wrapOk<unknown>([], LODESTONE_CHANNEL_V0).request_id);
    }
    expect(ids.size).toBe(50);
  });

  it("respects an explicit requestId override (used by feedback tests)", () => {
    const env = wrapOk<unknown>([], LODESTONE_CHANNEL_V0, { requestId: "custom-1" });
    expect(env.request_id).toBe("custom-1");
  });

  it("defaults provenance to NOT_READY_PROVENANCE when omitted", () => {
    const env = wrapOk<unknown>([], LODESTONE_CHANNEL_V0);
    expect(env.provenance).toEqual(NOT_READY_PROVENANCE);
    expect(env.provenance.source).toBe("not_ready");
  });

  it("preserves caller-supplied provenance + diagnostics", () => {
    const prov = { ...NOT_READY_PROVENANCE, is_git_repo: false as const };
    const diag = { ...emptyDiagnostics(), warnings: ["hello"] };
    const env = wrapOk<unknown>([], LODESTONE_CHANNEL_V0, {
      provenance: prov,
      diagnostics: diag,
    });
    expect(env.provenance).toBe(prov);
    expect(env.diagnostics).toBe(diag);
  });
});

describe("wrapErr / wrapNotImplemented / wrapNotReady", () => {
  it("wrapErr returns empty results with the message in warnings", () => {
    const env = wrapErr<unknown>("kaboom", LODESTONE_CHANNEL_V0);
    expect(env.results).toEqual([]);
    expect(env.diagnostics.warnings).toEqual(["kaboom"]);
    expect(env.channel).toBe("code");
  });

  it("wrapNotImplemented uses the canonical 'not_implemented' warning", () => {
    const env = wrapNotImplemented(LODESTONE_CHANNEL_V0);
    expect(env.diagnostics.warnings).toEqual(["not_implemented"]);
    expect(env.results).toEqual([]);
  });

  it("wrapNotReady uses the spec-mandated 'index not ready' warning", () => {
    const env = wrapNotReady(LODESTONE_CHANNEL_V0);
    expect(env.diagnostics.warnings).toEqual(["index not ready, see lodestone status"]);
    expect(env.provenance).toEqual(NOT_READY_PROVENANCE);
  });
});

describe("emptyDiagnostics", () => {
  it("returns the canonical zero-coverage shape", () => {
    const d = emptyDiagnostics();
    expect(d.coverage).toBe(0);
    expect(d.coverage_basis).toBe("files-indexed-vs-non-ignored");
    expect(d.warnings).toBeUndefined();
  });
});

// SPDX-License-Identifier: Apache-2.0
// max_response_kb truncation tests.
import { describe, it, expect } from "vitest";

import { LODESTONE_CHANNEL_V0, wrapOk } from "../envelope.js";
import { enforceMaxResponseKb, envelopeByteLength } from "../truncate.js";

describe("enforceMaxResponseKb", () => {
  it("returns the envelope unchanged when within budget", () => {
    const env = wrapOk<{ id: number }>([{ id: 1 }, { id: 2 }], LODESTONE_CHANNEL_V0);
    const out = enforceMaxResponseKb(env, 256);
    expect(out).toBe(env);
    expect(out.truncated).toBeUndefined();
  });

  it("drops tail results to fit budget; sets truncated:true and warning", () => {
    // Build an oversized envelope (>1 KB) with many uniform results.
    const blob = "x".repeat(200);
    const results = Array.from({ length: 50 }, (_, i) => ({ i, blob }));
    const env = wrapOk(results, LODESTONE_CHANNEL_V0);
    expect(envelopeByteLength(env)).toBeGreaterThan(1024);

    const out = enforceMaxResponseKb(env, 1);
    expect(out.truncated).toBe(true);
    expect(out.results.length).toBeLessThan(50);
    expect(envelopeByteLength(out)).toBeLessThanOrEqual(1024);
    expect(out.diagnostics.warnings).toContain("response truncated to fit max_response_kb=1");
    expect(out.diagnostics.truncated).toBe(true);
  });

  it("preserves provenance + diagnostics shape (load-bearing fields untouched)", () => {
    const blob = "y".repeat(200);
    const results = Array.from({ length: 20 }, (_, i) => ({ i, blob }));
    const env = wrapOk(results, LODESTONE_CHANNEL_V0);
    const before = JSON.stringify(env.provenance);
    const out = enforceMaxResponseKb(env, 1);
    expect(JSON.stringify(out.provenance)).toBe(before);
    expect(out.diagnostics.coverage).toBe(0);
    expect(out.diagnostics.coverage_basis).toBe("files-indexed-vs-non-ignored");
  });

  it("does not mutate the input envelope (returns a clone)", () => {
    const blob = "z".repeat(200);
    const results = Array.from({ length: 30 }, (_, i) => ({ i, blob }));
    const env = wrapOk(results, LODESTONE_CHANNEL_V0);
    const originalLen = env.results.length;
    enforceMaxResponseKb(env, 1);
    expect(env.results.length).toBe(originalLen);
    expect(env.truncated).toBeUndefined();
  });

  it("preserves prior diagnostics.warnings when adding the truncation warning", () => {
    const env = wrapOk(
      Array.from({ length: 20 }, (_, i) => ({ i, blob: "w".repeat(200) })),
      LODESTONE_CHANNEL_V0,
    );
    env.diagnostics = { ...env.diagnostics, warnings: ["pre-existing warning"] };
    const out = enforceMaxResponseKb(env, 1);
    expect(out.diagnostics.warnings).toContain("pre-existing warning");
    expect(out.diagnostics.warnings).toContain("response truncated to fit max_response_kb=1");
  });

  it("rejects invalid maxKb values", () => {
    const env = wrapOk<unknown>([], LODESTONE_CHANNEL_V0);
    expect(() => enforceMaxResponseKb(env, 0)).toThrow();
    expect(() => enforceMaxResponseKb(env, -1)).toThrow();
    expect(() => enforceMaxResponseKb(env, 1.5)).toThrow();
  });

  it("envelopeByteLength returns the JSON.stringify byte count", () => {
    const env = wrapOk<unknown>([], LODESTONE_CHANNEL_V0);
    expect(envelopeByteLength(env)).toBe(Buffer.byteLength(JSON.stringify(env), "utf8"));
  });
});

// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { output } from "../ui/output.js";

describe("output sink", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("info / success → stdout", () => {
    output.info("hello");
    output.success("done");
    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("warn / error → stderr", () => {
    output.warn("careful");
    output.error("oops");
    expect(errSpy).toHaveBeenCalledTimes(2);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("json(obj) → one line of valid JSON to stdout", () => {
    output.json({ a: 1, b: "two" });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const printed = logSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(printed);
    expect(parsed).toEqual({ a: 1, b: "two" });
    expect(printed).not.toContain("\n");
  });

  it("with NO_COLOR set, output is pure ASCII (no ANSI sequences, no Unicode glyphs)", () => {
    const prev = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      output.success("colored?");
      output.warn("careful");
      output.error("oops");
      const allOutput = [
        ...logSpy.mock.calls.flat(),
        ...errSpy.mock.calls.flat(),
      ].join("\n");
      // ANSI escape sequence regex (build with String.fromCharCode to avoid
      // smuggling a literal ESC byte into source).
      const ansi = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`);
      expect(ansi.test(allOutput)).toBe(false);
      // Output must be pure 7-bit ASCII — Unicode glyphs would render as
      // mojibake on Windows cmd.exe with cp437 default codepage.
      const ascii = /^[\x20-\x7E\n]*$/;
      expect(ascii.test(allOutput)).toBe(true);
      // ASCII prefix tags should appear (replaces the old ✓/!/✗ glyphs).
      expect(allOutput).toContain("[ok]");
      expect(allOutput).toContain("[warn]");
      expect(allOutput).toContain("[err]");
    } finally {
      if (prev === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prev;
    }
  });
});

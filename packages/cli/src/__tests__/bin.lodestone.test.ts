// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../main.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "..");
const BIN_TS = path.join(SRC, "bin", "lodestone.ts");

describe("bin/lodestone.ts entry", () => {
  it("file exists and starts with the literal `#!/usr/bin/env node` shebang", () => {
    expect(existsSync(BIN_TS)).toBe(true);
    const text = readFileSync(BIN_TS, "utf8");
    expect(text.startsWith("#!/usr/bin/env node")).toBe(true);
  });

  it("delegates to main(); main() is a real async function returning a number", async () => {
    expect(typeof main).toBe("function");
    const ret = main(["--version"]);
    expect(ret).toBeInstanceOf(Promise);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await ret;
    expect(typeof code).toBe("number");
    log.mockRestore();
  });

  it("main() catches synchronous handler throws → friendly stderr line, exit 1, no stack", async () => {
    // Use vi.doMock to inject a handler that throws. This exercises the
    // try/catch in main() directly, not just the dispatch path.
    vi.resetModules();
    vi.doMock("../routing/dispatch.js", () => ({
      dispatch: async () => {
        throw new Error("forced-throw-for-test");
      },
      HANDLERS: {},
      SUBCOMMANDS: [],
    }));
    const { main: mainWithThrowingDispatch } = await import("../main.js");
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = await mainWithThrowingDispatch(["any-cmd"]);
    expect(code).toBe(1);
    const printed = err.mock.calls.flat().join("\n");
    expect(printed).toContain("Internal error");
    expect(printed).toContain("forced-throw-for-test");
    // Without LODESTONE_DEBUG set, no stack frames should leak.
    expect(printed).not.toMatch(/at Object\./);
    err.mockRestore();
    vi.doUnmock("../routing/dispatch.js");
    vi.resetModules();
  });

  it("LODESTONE_DEBUG=1 appends the stack on caught throws", async () => {
    vi.resetModules();
    vi.doMock("../routing/dispatch.js", () => ({
      dispatch: async () => {
        throw new Error("forced-throw-for-debug");
      },
      HANDLERS: {},
      SUBCOMMANDS: [],
    }));
    const { main: mainWithThrowingDispatch } = await import("../main.js");
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const prev = process.env.LODESTONE_DEBUG;
    process.env.LODESTONE_DEBUG = "1";
    try {
      const code = await mainWithThrowingDispatch(["any-cmd"]);
      expect(code).toBe(1);
      const printed = err.mock.calls.flat().join("\n");
      expect(printed).toContain("Internal error");
      // Stack frame should be present under DEBUG.
      expect(printed).toMatch(/Error: forced-throw-for-debug/);
    } finally {
      if (prev === undefined) delete process.env.LODESTONE_DEBUG;
      else process.env.LODESTONE_DEBUG = prev;
      err.mockRestore();
      vi.doUnmock("../routing/dispatch.js");
      vi.resetModules();
    }
  });
});

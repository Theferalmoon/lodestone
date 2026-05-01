// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { main } from "../main.js";
import { VERSION, COMMIT_HASH } from "../version.js";

describe("--version / -v", () => {
  it("prints version + commit hash to stdout", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await main(["--version"]);
    expect(code).toBe(0);
    const printed = log.mock.calls.flat().join("\n");
    expect(printed).toContain(VERSION);
    expect(printed).toContain(COMMIT_HASH);
    log.mockRestore();
  });

  it("`-v` is accepted as a synonym", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await main(["-v"]);
    expect(code).toBe(0);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("VERSION is non-empty and from this package's package.json", () => {
    expect(VERSION).not.toBe("");
    expect(VERSION).not.toBe("0.0.0-unknown");
  });

  it("COMMIT_HASH is a non-empty string (git short hash, build-injected, or 'dev')", () => {
    expect(typeof COMMIT_HASH).toBe("string");
    expect(COMMIT_HASH.length).toBeGreaterThan(0);
  });
});

// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { main } from "../main.js";
import { SUBCOMMANDS } from "../routing/help.js";
import { HANDLERS } from "../routing/dispatch.js";

const EXPECTED_NAMES = [
  "init",
  "status",
  "reindex",
  "doctor",
  "plan-tests",
  "seed-skills",
  "upgrade",
  "uninstall",
  "client-smoke",
  "setup-models",
] as const;

describe("--help / no-args", () => {
  it("--help lists all subcommands", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await main(["--help"]);
    expect(code).toBe(0);
    const printed = log.mock.calls.flat().join("\n");
    for (const name of EXPECTED_NAMES) {
      expect(printed).toContain(name);
    }
    log.mockRestore();
  });

  it("bare `lodestone` (no args) prints the same top-level help", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await main([]);
    expect(code).toBe(0);
    const printed = log.mock.calls.flat().join("\n");
    for (const name of EXPECTED_NAMES) {
      expect(printed).toContain(name);
    }
    log.mockRestore();
  });

  it("-h is accepted as a synonym for --help", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await main(["-h"]);
    expect(code).toBe(0);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("SUBCOMMANDS list and HANDLERS table are in lock-step", () => {
    const helpNames = new Set(SUBCOMMANDS.map((s) => s.name));
    const handlerNames = new Set(Object.keys(HANDLERS));
    expect([...helpNames].sort()).toEqual([...handlerNames].sort());
  });
});

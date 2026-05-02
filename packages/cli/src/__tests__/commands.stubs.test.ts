// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { reindex } from "../commands/reindex.js";
import { doctor } from "../commands/doctor.js";
import { seedSkills } from "../commands/seed-skills.js";
import { upgrade } from "../commands/upgrade.js";
// init() is no longer a stub — it does real install work in §04.
// See commands.init.test.ts for its dedicated coverage.
// uninstall() is no longer a stub — it does real reversal work in §19.
// See commands.uninstall.test.ts for its dedicated coverage.

describe("stub commands (return 0, warn, accept future flags)", () => {
  it("reindex() stub returns 0", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await reindex([])).toBe(0);
    err.mockRestore();
  });

  it("doctor() stub returns 0 and warns about future probes", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await doctor([])).toBe(0);
    const printed = err.mock.calls.flat().join("\n");
    expect(printed.toLowerCase()).toContain("doctor");
    err.mockRestore();
  });

  it("seed-skills stub returns 0", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await seedSkills([])).toBe(0);
    err.mockRestore();
  });

  it("upgrade stub returns 0", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await upgrade([])).toBe(0);
    err.mockRestore();
  });

});

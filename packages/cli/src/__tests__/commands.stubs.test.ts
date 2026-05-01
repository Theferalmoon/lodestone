// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { init, parseInitArgv } from "../commands/init.js";
import { reindex } from "../commands/reindex.js";
import { doctor } from "../commands/doctor.js";
import { seedSkills } from "../commands/seed-skills.js";
import { upgrade } from "../commands/upgrade.js";
import { uninstall, parseUninstallArgv } from "../commands/uninstall.js";

describe("stub commands (return 0, warn, accept future flags)", () => {
  it("init() stub returns 0 and warns", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await init([])).toBe(0);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("init parser accepts --write-claude-md and --pro flags", () => {
    expect(parseInitArgv([])).toEqual({ writeClaudeMd: false, pro: false });
    expect(parseInitArgv(["--write-claude-md"])).toEqual({ writeClaudeMd: true, pro: false });
    expect(parseInitArgv(["--pro"])).toEqual({ writeClaudeMd: false, pro: true });
    expect(parseInitArgv(["--write-claude-md", "--pro"])).toEqual({
      writeClaudeMd: true,
      pro: true,
    });
  });

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

  it("uninstall() stub returns 0; parser accepts --dry-run", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await uninstall(["--dry-run"])).toBe(0);
    expect(parseUninstallArgv([])).toEqual({ dryRun: false });
    expect(parseUninstallArgv(["--dry-run"])).toEqual({ dryRun: true });
    err.mockRestore();
  });
});

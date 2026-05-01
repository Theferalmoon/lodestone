// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { main } from "../main.js";

describe("dispatch", () => {
  it("unknown subcommand: returns exit 2 + suggests closest match on stderr", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = await main(["inti"]);
    expect(code).toBe(2);
    const printed = err.mock.calls.flat().join("\n");
    expect(printed).toContain("Unknown command:");
    expect(printed).toContain("Did you mean: init");
    err.mockRestore();
  });

  it("unknown subcommand far from any known: still exits 2 (no suggestion)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = await main(["wat-is-this"]);
    expect(code).toBe(2);
    err.mockRestore();
  });

  it("`init` dispatches to the init stub (warns, returns 0)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = await main(["init"]);
    expect(code).toBe(0);
    const printed = err.mock.calls.flat().join("\n");
    expect(printed).toMatch(/init.*not yet implemented/i);
    err.mockRestore();
  });

  it("`seed-skills` dispatches to the seed-skills stub", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = await main(["seed-skills"]);
    expect(code).toBe(0);
    const printed = err.mock.calls.flat().join("\n");
    expect(printed).toMatch(/seed-skills.*not yet implemented/i);
    err.mockRestore();
  });

  it("`uninstall --dry-run` is accepted by the parser (stub returns 0)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = await main(["uninstall", "--dry-run"]);
    expect(code).toBe(0);
    err.mockRestore();
  });

  it("`init --write-claude-md --pro` is accepted (stub returns 0)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = await main(["init", "--write-claude-md", "--pro"]);
    expect(code).toBe(0);
    err.mockRestore();
  });
});

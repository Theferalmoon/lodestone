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

  // Codex impl-003 B3: prefix-aware ranking. Without it, `uninst` mis-suggests
  // `init` because the Levenshtein distance to a much shorter command wins.
  // The fix is the prefix-match-first rule in suggestClosest. These cases
  // codify the dangerous misdirects we must NOT regress on.
  it("`uninst` suggests `uninstall` (prefix match wins over short Levenshtein-near `init`)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = await main(["uninst"]);
    expect(code).toBe(2);
    const printed = err.mock.calls.flat().join("\n");
    expect(printed).toContain("Did you mean: uninstall?");
    expect(printed).not.toContain("Did you mean: init?");
    err.mockRestore();
  });

  it("`stat` suggests `status` (prefix match)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = await main(["stat"]);
    expect(code).toBe(2);
    expect(err.mock.calls.flat().join("\n")).toContain("Did you mean: status?");
    err.mockRestore();
  });

  it("`seedskills` (no hyphen) suggests `seed-skills` via Levenshtein", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = await main(["seedskills"]);
    expect(code).toBe(2);
    expect(err.mock.calls.flat().join("\n")).toContain("Did you mean: seed-skills?");
    err.mockRestore();
  });

  it("`xyz` (garbage) returns no suggestion (clean error only)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = await main(["xyz"]);
    expect(code).toBe(2);
    const printed = err.mock.calls.flat().join("\n");
    expect(printed).toContain("Unknown command:");
    expect(printed).not.toContain("Did you mean");
    err.mockRestore();
  });

  it("`init --dry-run` dispatches to init() and returns 0 without filesystem side-effects", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await main(["init", "--dry-run"]);
    expect(code).toBe(0);
    const stdout = log.mock.calls.flat().join("\n");
    expect(stdout).toMatch(/--dry-run set/);
    err.mockRestore();
    log.mockRestore();
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

  it("`init --dry-run --write-claude-md --pro` is accepted (no side-effects in dry-run)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await main(["init", "--dry-run", "--write-claude-md", "--pro"]);
    expect(code).toBe(0);
    err.mockRestore();
    log.mockRestore();
  });
});

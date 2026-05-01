// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../config/load.js";

describe("loadConfig", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "lodestone-config-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("missing lodestone.toml: returns defaults with project.name derived from cwd basename", async () => {
    // No .lodestone/ at all — should still not throw.
    const config = await loadConfig(tmp);
    expect(config.project.name).toBe(path.basename(path.resolve(tmp)));
    expect(config.ingest.debounce_ms).toBe(600);
    expect(config.cluster.algorithm).toBe("louvain");
  });

  it("present + parseable lodestone.toml: parses + applies defaults for missing keys", async () => {
    mkdirSync(path.join(tmp, ".lodestone"));
    writeFileSync(
      path.join(tmp, ".lodestone", "lodestone.toml"),
      `[project]\nname = "demo"\n[ingest]\ndebounce_ms = 250\n`
    );
    const config = await loadConfig(tmp);
    expect(config.project.name).toBe("demo");
    expect(config.ingest.debounce_ms).toBe(250);
    expect(config.ingest.mode).toBe("watch"); // default still applied
  });

  it("malformed TOML: throws (friend needs to know their config is bad)", async () => {
    mkdirSync(path.join(tmp, ".lodestone"));
    writeFileSync(path.join(tmp, ".lodestone", "lodestone.toml"), `[project\nname = oops`);
    await expect(loadConfig(tmp)).rejects.toThrow();
  });

  it("malformed schema (unknown algorithm): throws with field path", async () => {
    mkdirSync(path.join(tmp, ".lodestone"));
    writeFileSync(
      path.join(tmp, ".lodestone", "lodestone.toml"),
      `[project]\nname = "demo"\n[cluster]\nalgorithm = "infomap"\n`
    );
    await expect(loadConfig(tmp)).rejects.toThrow(/algorithm/);
  });

  it("does not mutate the underlying parsed object (no in-place writes)", async () => {
    // Run twice against the same fixture; if loadConfig mutated state, the
    // second call could observe altered data. Defensive smoke test.
    mkdirSync(path.join(tmp, ".lodestone"));
    writeFileSync(
      path.join(tmp, ".lodestone", "lodestone.toml"),
      `[project]\nname = "demo"\n`
    );
    const a = await loadConfig(tmp);
    const b = await loadConfig(tmp);
    expect(a.project.name).toBe("demo");
    expect(b.project.name).toBe("demo");
    expect(a.ingest.debounce_ms).toBe(b.ingest.debounce_ms);
  });

  it("works on a path with trailing slash", async () => {
    const trailing = `${tmp}/`;
    const config = await loadConfig(trailing);
    expect(config.project.name).toBe(path.basename(path.resolve(tmp)));
  });
});

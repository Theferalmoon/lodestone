// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { installRuntime } from "./runtime.js";

describe("installRuntime", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "lodestone-runtime-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("creates an executable shim at <repoRoot>/.lodestone/runtime/lodestone-mcp", () => {
    const result = installRuntime(tmp);
    expect(result.action).toBe("created");
    const expected = path.join(tmp, ".lodestone", "runtime", "lodestone-mcp");
    expect(result.path).toBe(expected);
    expect(existsSync(expected)).toBe(true);
    // 0755 — owner rwx, group/world r-x
    const mode = statSync(expected).mode & 0o777;
    expect(mode).toBe(0o755);
  });

  it("the shim invokes node against the resolved @lodestone/mcp-server entry", () => {
    const result = installRuntime(tmp);
    const body = readFileSync(result.path, "utf8");
    expect(body.startsWith("#!/bin/sh\n")).toBe(true);
    expect(body).toContain(`exec node "${result.serverPath}"`);
    // The resolved server path must be absolute and end at server.js.
    expect(path.isAbsolute(result.serverPath)).toBe(true);
    expect(result.serverPath.endsWith("server.js")).toBe(true);
    // The resolved server.js must actually exist (resolveMcpServerEntry
    // throws otherwise; this asserts the test fixture's expectation).
    expect(existsSync(result.serverPath)).toBe(true);
  });

  it("re-running returns 'updated' and refreshes the shim body", () => {
    const first = installRuntime(tmp);
    expect(first.action).toBe("created");
    const second = installRuntime(tmp);
    expect(second.action).toBe("updated");
    expect(second.path).toBe(first.path);
    // Body byte-identical on a clean re-run (resolveMcpServerEntry is
    // deterministic for a given install).
    const body1 = readFileSync(first.path, "utf8");
    const body2 = readFileSync(second.path, "utf8");
    expect(body1).toBe(body2);
  });

  it("creates the runtime/ parent directory if absent", () => {
    expect(existsSync(path.join(tmp, ".lodestone"))).toBe(false);
    installRuntime(tmp);
    expect(existsSync(path.join(tmp, ".lodestone", "runtime"))).toBe(true);
  });
});

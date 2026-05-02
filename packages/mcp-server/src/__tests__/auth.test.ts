// SPDX-License-Identifier: Apache-2.0
// auth.ts trust-boundary tests. The grep test prevents future refactors from
// silently dropping the boundary documentation block.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import { assertLocalStdioTrust } from "../auth.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AUTH_TS = path.join(HERE, "..", "auth.ts");

describe("auth.ts trust boundary", () => {
  it("assertLocalStdioTrust() returns true (v0 no-op)", () => {
    expect(assertLocalStdioTrust()).toBe(true);
  });

  it("source file contains the canonical 'local stdio = trust the user' phrase", () => {
    const src = readFileSync(AUTH_TS, "utf8");
    expect(src).toMatch(/local stdio = trust the user/);
  });

  it("source file documents the v0 trust boundary (no network, no port, no auth)", () => {
    const src = readFileSync(AUTH_TS, "utf8");
    expect(src).toMatch(/no network listener/i);
    expect(src).toMatch(/no port binding/i);
    expect(src).toMatch(/no auth handshake/i);
  });
});

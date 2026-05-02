// SPDX-License-Identifier: Apache-2.0
// Tests for the shared sha256File helper. Pinned reference vectors so
// any cross-package caller (setup-models, snowflake fallback) can rely
// on byte-identical hash output.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { sha256File } from "../sha256.js";

describe("sha256File", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "lodestone-sha256-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns the lowercase-hex SHA256 of file contents", () => {
    const f = path.join(tmp, "hello.txt");
    writeFileSync(f, "hello");
    // Reference: echo -n "hello" | sha256sum
    expect(sha256File(f)).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    );
  });

  it("returns the canonical empty-string SHA256 for an empty file", () => {
    const f = path.join(tmp, "empty");
    writeFileSync(f, "");
    expect(sha256File(f)).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });

  it("hashes binary data correctly (no utf8 corruption)", () => {
    const f = path.join(tmp, "bin");
    writeFileSync(f, Buffer.from([0x00, 0xff, 0x10, 0x20]));
    // Reference: printf '\x00\xff\x10\x20' | sha256sum
    expect(sha256File(f)).toBe(
      "4033e6f229164922f1600f00a2dacd22e9b9bbdad58f82dd95095b0bb648eb83"
    );
  });

  it("produces a stable hash across repeated calls", () => {
    const f = path.join(tmp, "stable");
    writeFileSync(f, "the quick brown fox");
    const a = sha256File(f);
    const b = sha256File(f);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("throws when the file does not exist", () => {
    expect(() => sha256File(path.join(tmp, "nope"))).toThrow();
  });
});

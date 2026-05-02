// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { slugify } from "../slug.js";

describe("slugify", () => {
  it("lowercases, hyphenates spaces and strips non-[a-z0-9-]", () => {
    expect(slugify("Auth Pipeline & Hooks", "abc12345")).toBe("auth-pipeline-hooks");
  });

  it("collapses runs of dashes/underscores", () => {
    expect(slugify("foo___bar  baz", "abc")).toBe("foo-bar-baz");
  });

  it("trims leading/trailing dashes", () => {
    expect(slugify("---hello---", "abc")).toBe("hello");
  });

  it("falls back to cluster-<id> when input has no [a-z0-9]", () => {
    expect(slugify("!!!@@@$$$", "abcd1234efgh")).toBe("cluster-abcd1234");
  });

  it("falls back to cluster-unknown if both name and id are empty", () => {
    expect(slugify("", "")).toBe("cluster-unknown");
  });

  it("truncates to 60 chars and trims trailing dash from truncation", () => {
    const long = "a".repeat(80);
    expect(slugify(long, "x").length).toBe(60);
  });
});

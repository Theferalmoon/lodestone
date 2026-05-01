// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { getClaudeMdSnippet, printClaudeMdSnippet } from "./snippet.js";

describe("getClaudeMdSnippet", () => {
  it("returns a non-empty string mentioning Lodestone", () => {
    const snippet = getClaudeMdSnippet();
    expect(snippet.length).toBeGreaterThan(0);
    expect(snippet).toMatch(/Lodestone/);
  });

  it("names the moat tools (cluster + skills_for) prominently", () => {
    const snippet = getClaudeMdSnippet();
    expect(snippet).toMatch(/cluster/);
    expect(snippet).toMatch(/skills_for/);
  });

  it("uses Markdown formatting (heading + bullets)", () => {
    const snippet = getClaudeMdSnippet();
    // heading line
    expect(snippet).toMatch(/^#\s+/m);
    // at least one bullet
    expect(snippet).toMatch(/^[-*]\s+/m);
  });

  it("snapshot — shape stable", () => {
    expect(getClaudeMdSnippet()).toMatchSnapshot();
  });
});

describe("printClaudeMdSnippet", () => {
  it("emits a leading instruction line, the snippet, and a trailing blank line, all to stdout", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      printClaudeMdSnippet();
      const captured = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(captured).toMatch(/Add this to your CLAUDE\.md/i);
      expect(captured).toMatch(/Lodestone/);
    } finally {
      log.mockRestore();
    }
  });
});

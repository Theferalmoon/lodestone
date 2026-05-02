// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  parseFrontmatter,
  renderFrontmatter,
  sourceToMaturity,
  type FrontmatterFields,
} from "../frontmatter.js";

function fixture(): FrontmatterFields {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    slug: "auth-pipeline",
    name: "Auth pipeline",
    description: "Login + token issuance + verification.",
    source: "emerging",
    source_cluster_id: "abcd1234abcd1234",
    emitted_at: "2026-05-01T12:00:00.000Z",
    content_sha256: "deadbeef".repeat(8),
    member_count: 5,
    top_symbols: ["src/auth.ts::login", "src/auth.ts::verifyToken"],
    confidence: 0.62,
    observed_days: 7,
    evidence_count: 5,
  };
}

describe("renderFrontmatter / parseFrontmatter", () => {
  it("renders a fenced YAML block ending in --- and a trailing newline", () => {
    const out = renderFrontmatter(fixture());
    expect(out.startsWith("---\n")).toBe(true);
    expect(out.endsWith("---\n")).toBe(true);
  });

  it("round-trips through parseFrontmatter with body recovered intact", () => {
    const fm = fixture();
    const text = `${renderFrontmatter(fm)}# body\n\nhello\n`;
    const parsed = parseFrontmatter(text);
    expect(parsed).not.toBeNull();
    expect(parsed!.fields.slug).toBe(fm.slug);
    expect(parsed!.fields.content_sha256).toBe(fm.content_sha256);
    expect(parsed!.fields.top_symbols).toEqual(fm.top_symbols);
    expect(parsed!.body).toBe("# body\n\nhello\n");
  });

  it("returns null when there is no opening --- fence", () => {
    expect(parseFrontmatter("no fence here")).toBeNull();
  });

  it("returns null when the closing --- fence is missing", () => {
    expect(parseFrontmatter("---\nfoo: bar\n")).toBeNull();
  });

  it("returns null when the YAML body parses to a non-object", () => {
    expect(parseFrontmatter("---\nplain string scalar\n---\nbody\n")).toBeNull();
  });

  it("omits source_cluster_id when not provided", () => {
    const fm = fixture();
    delete fm.source_cluster_id;
    const text = renderFrontmatter(fm);
    expect(text).not.toMatch(/source_cluster_id/);
  });

  it("maps source labels to Maturity enum", () => {
    expect(sourceToMaturity("seed")).toBe("deterministic_seed");
    expect(sourceToMaturity("emerging")).toBe("emerging");
    expect(sourceToMaturity("observed")).toBe("observed");
  });
});

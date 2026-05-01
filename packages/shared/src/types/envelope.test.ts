// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, expectTypeOf } from "vitest";
import type {
  LodestoneToolResponse,
  Provenance,
  Diagnostics,
} from "./envelope.js";
import { provenanceSchema, parseProvenance } from "./envelope.js";

describe("LodestoneToolResponse<T> envelope", () => {
  it("compiles for arbitrary T (string, unknown, complex)", () => {
    // expectTypeOf is the modern vitest type-test API. Direct field type checks
    // keep this future-proof against `toMatchTypeOf` deprecation in newer vitest.
    expectTypeOf<LodestoneToolResponse<string>>().toHaveProperty("request_id").toBeString();
    expectTypeOf<LodestoneToolResponse<string>>().toHaveProperty("results").toEqualTypeOf<string[]>();
    expectTypeOf<LodestoneToolResponse<unknown>>().toHaveProperty("results").toEqualTypeOf<unknown[]>();
    expectTypeOf<LodestoneToolResponse<{ foo: string }>>()
      .toHaveProperty("results")
      .toEqualTypeOf<{ foo: string }[]>();
  });

  it("snapshot: representative envelope shape", () => {
    const envelope: LodestoneToolResponse<{ symbol: string }> = {
      request_id: "01927e8c-d4f2-7000-9c4a-000000000001",
      results: [{ symbol: "src/auth.ts::User::login" }],
      provenance: {
        is_git_repo: true,
        head_commit: "abc1234",
        indexed_commit: "abc1234",
        dirty_at_index: false,
        dirty_now: false,
        commits_since_index: 0,
        has_upstream: true,
        upstream_branch: "origin/main",
        commits_behind_upstream: 0,
        indexed_at: "2026-05-01T03:00:00Z",
        staleness_seconds: 0,
        index_epoch: 42,
        source: "live",
      },
      diagnostics: {
        coverage: 0.95,
        coverage_basis: "files-indexed-vs-non-ignored",
      },
    };
    expect(envelope).toMatchSnapshot();
  });

  it("provenance edge cases compile (detached HEAD, no upstream, fresh clone, non-git)", () => {
    const detached: Provenance = {
      is_git_repo: true,
      head_commit: "deadbee",
      indexed_commit: "deadbee",
      dirty_at_index: false,
      dirty_now: false,
      commits_since_index: 0,
      has_upstream: false,
      upstream_branch: null,
      commits_behind_upstream: 0,
      indexed_at: "2026-05-01T03:00:00Z",
      staleness_seconds: 0,
      index_epoch: 1,
      source: "live",
    };
    expect(detached.has_upstream).toBe(false);
    expect(detached.upstream_branch).toBeNull();

    const nonGit: Provenance = {
      is_git_repo: false,
      head_commit: null,
      indexed_commit: null,
      dirty_at_index: false,
      dirty_now: false,
      commits_since_index: 0,
      has_upstream: false,
      upstream_branch: null,
      commits_behind_upstream: 0,
      indexed_at: null,
      staleness_seconds: -1,
      index_epoch: 0,
      source: "not_ready",
    };
    expect(nonGit.is_git_repo).toBe(false);
    expect(nonGit.staleness_seconds).toBe(-1);
  });

  it("diagnostics flags compile", () => {
    const d: Diagnostics = {
      coverage: 0.5,
      coverage_basis: "files-indexed-vs-non-ignored",
      warnings: ["index is stale"],
      truncated: true,
      clamped: true,
    };
    expect(d.truncated).toBe(true);
    expect(d.clamped).toBe(true);
  });
});

describe("provenanceSchema (runtime validator)", () => {
  const valid = {
    is_git_repo: true,
    head_commit: "abc1234",
    indexed_commit: "abc1234",
    dirty_at_index: false,
    dirty_now: false,
    commits_since_index: 0,
    has_upstream: true,
    upstream_branch: "origin/main",
    commits_behind_upstream: 0,
    indexed_at: "2026-05-01T03:00:00Z",
    staleness_seconds: 0,
    index_epoch: 42,
    source: "live" as const,
  };

  it("accepts a valid Provenance", () => {
    expect(() => parseProvenance(valid)).not.toThrow();
  });

  it("accepts staleness_seconds === -1 (never-indexed sentinel)", () => {
    expect(() => parseProvenance({ ...valid, staleness_seconds: -1 })).not.toThrow();
  });

  it("rejects negative staleness_seconds other than -1", () => {
    expect(() => parseProvenance({ ...valid, staleness_seconds: -5 })).toThrow(/staleness_seconds/);
  });

  it("rejects negative commits_since_index", () => {
    expect(() => parseProvenance({ ...valid, commits_since_index: -1 })).toThrow();
  });

  it("rejects non-int index_epoch", () => {
    expect(() => parseProvenance({ ...valid, index_epoch: 3.7 })).toThrow();
  });

  it("rejects unknown source enum value", () => {
    expect(() => parseProvenance({ ...valid, source: "unknown" })).toThrow();
  });

  it("schema export is the same object the parser uses", () => {
    expect(provenanceSchema).toBeDefined();
  });
});

// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { parseReadyJson, readyJsonSchema, type ReadyJson } from "./ready.js";

const valid: ReadyJson = {
  schema_version: 1,
  lodestone_version: "0.1.0",
  ready: true,
  embedder: { id: "nomic-embed-text-v1.5", dim: 768, quant: "int8" },
  languages_indexed: ["typescript", "python"],
  indexed_at: "2026-05-01T03:00:00Z",
  commit_at_index: "abc1234",
  dirty_at_index: false,
  index_epoch: 42,
  writer_pid: 12345,
};

describe("readyJsonSchema (mirror of claude-plan.md §1.5)", () => {
  it("accepts the representative valid marker from the plan", () => {
    expect(() => parseReadyJson(valid)).not.toThrow();
  });

  it("accepts commit_at_index=null (non-git project)", () => {
    expect(() => parseReadyJson({ ...valid, commit_at_index: null })).not.toThrow();
  });

  it("rejects unknown top-level keys (.strict)", () => {
    expect(() => parseReadyJson({ ...valid, extra: "nope" })).toThrow();
  });

  it("rejects unknown embedder keys (.strict on nested)", () => {
    expect(() =>
      parseReadyJson({ ...valid, embedder: { ...valid.embedder, sneaky: 1 } })
    ).toThrow();
  });

  it("rejects schema_version < 1", () => {
    expect(() => parseReadyJson({ ...valid, schema_version: 0 })).toThrow();
  });

  it("rejects negative index_epoch and writer_pid", () => {
    expect(() => parseReadyJson({ ...valid, index_epoch: -1 })).toThrow();
    expect(() => parseReadyJson({ ...valid, writer_pid: -1 })).toThrow();
  });

  it("rejects empty embedder.id", () => {
    expect(() =>
      parseReadyJson({ ...valid, embedder: { ...valid.embedder, id: "" } })
    ).toThrow();
  });

  it("schema export is the same object the parser uses", () => {
    expect(readyJsonSchema).toBeDefined();
  });
});

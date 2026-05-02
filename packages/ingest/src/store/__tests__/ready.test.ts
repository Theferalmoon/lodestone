// SPDX-License-Identifier: Apache-2.0
// Tests for ready.ts - atomic write/read of ready.json + assertReady.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LODESTONE_DIRNAME, type ReadyJson } from "@lodestone/shared";

import { assertReady, readReady, readyPath, writeReady } from "../ready.js";

let workdir: string;
let lodestoneDir: string;

function buildMarker(overrides: Partial<ReadyJson> = {}): ReadyJson {
  return {
    schema_version: 1,
    lodestone_version: "0.1.0",
    ready: true,
    embedder: { id: "nomic-embed-text-v1.5", dim: 768, quant: "int8" },
    languages_indexed: ["typescript"],
    indexed_at: "2026-05-01T03:00:00Z",
    commit_at_index: "abc1234",
    dirty_at_index: false,
    index_epoch: 1,
    writer_pid: process.pid,
    ...overrides,
  };
}

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "lodestone-ready-test-"));
  lodestoneDir = join(workdir, LODESTONE_DIRNAME);
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe("readReady / writeReady round-trip", () => {
  it("writeReady then readReady is lossless", () => {
    const marker = buildMarker({ index_epoch: 42 });
    writeReady(lodestoneDir, marker);
    const readBack = readReady(lodestoneDir);
    expect(readBack).toEqual(marker);
  });

  it("readReady returns null when the file does not exist", () => {
    expect(readReady(lodestoneDir)).toBeNull();
  });

  it("readReady throws a clear error on malformed JSON", () => {
    mkdirSync(lodestoneDir, { recursive: true });
    writeFileSync(readyPath(lodestoneDir), "{ not valid json");
    expect(() => readReady(lodestoneDir)).toThrow(/malformed json/i);
  });

  it("readReady throws a Zod error when shape is wrong", () => {
    mkdirSync(lodestoneDir, { recursive: true });
    writeFileSync(readyPath(lodestoneDir), JSON.stringify({ ready: true }));
    expect(() => readReady(lodestoneDir)).toThrow();
  });
});

describe("writeReady atomicity + side effects", () => {
  it("creates the .lodestone/ parent dir if missing", () => {
    writeReady(lodestoneDir, buildMarker());
    const entries = readdirSync(lodestoneDir);
    expect(entries).toContain("ready.json");
  });

  it("leaves no .tmp file after success", () => {
    writeReady(lodestoneDir, buildMarker());
    const entries = readdirSync(lodestoneDir);
    expect(entries.some((e) => e.endsWith(".tmp"))).toBe(false);
  });

  it("validates marker shape before writing", () => {
    expect(() =>
      writeReady(lodestoneDir, { ready: true } as unknown as ReadyJson),
    ).toThrow();
  });

  it("readyPath accepts a project root and appends .lodestone/", () => {
    expect(readyPath(workdir)).toBe(join(workdir, LODESTONE_DIRNAME, "ready.json"));
  });

  it("readyPath accepts a .lodestone/ dir directly", () => {
    expect(readyPath(lodestoneDir)).toBe(join(lodestoneDir, "ready.json"));
  });
});

describe("assertReady", () => {
  it("returns the marker when ready.json is present and ready=true", () => {
    const marker = buildMarker();
    writeReady(lodestoneDir, marker);
    expect(assertReady(lodestoneDir)).toEqual(marker);
  });

  it("throws when ready.json is missing", () => {
    expect(() => assertReady(lodestoneDir)).toThrow(/not ready: no ready\.json/i);
  });

  it("throws when ready=false", () => {
    writeReady(lodestoneDir, buildMarker({ ready: false }));
    expect(() => assertReady(lodestoneDir)).toThrow(/ready=false/i);
  });

  it("throws when expectedEpoch does not match", () => {
    writeReady(lodestoneDir, buildMarker({ index_epoch: 7 }));
    expect(() => assertReady(lodestoneDir, 8)).toThrow(/epoch mismatch/i);
  });

  it("returns the marker when expectedEpoch matches", () => {
    writeReady(lodestoneDir, buildMarker({ index_epoch: 7 }));
    expect(assertReady(lodestoneDir, 7).index_epoch).toBe(7);
  });
});

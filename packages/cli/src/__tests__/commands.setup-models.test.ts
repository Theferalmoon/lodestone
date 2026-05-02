// SPDX-License-Identifier: Apache-2.0
//
// Tests for `lodestone setup-models` — the opt-in friend-facing embedder
// fetcher. Mocks fetch so CI never reaches HuggingFace, and overrides the
// manifest so test bytes / sha256 pairs are deterministic.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  parseSetupModelsArgv,
  runSetupModels,
  type FetchLike,
  type ModelPin,
} from "../commands/setup-models.js";

/** Compute sha256 of a Buffer / string for fixture pin construction. */
function sha256(input: Buffer | string): string {
  return createHash("sha256")
    .update(typeof input === "string" ? Buffer.from(input) : input)
    .digest("hex");
}

/**
 * Build a fake `fetch` that returns the supplied bytes (per URL) as a
 * Response-shaped object. Tracks call count so tests can assert no extra
 * network calls.
 */
function makeFakeFetch(table: Record<string, Buffer>): {
  fetch: FetchLike;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url: string) => {
    calls.push(url);
    const buf = table[url];
    if (!buf) {
      return {
        ok: false,
        status: 404,
        statusText: "Not Found (test stub)",
        body: null,
        async arrayBuffer() {
          return new ArrayBuffer(0);
        },
      };
    }
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      body: null,
      async arrayBuffer() {
        return buf.buffer.slice(
          buf.byteOffset,
          buf.byteOffset + buf.byteLength
        ) as ArrayBuffer;
      },
    };
  };
  return { fetch: fetchImpl, calls };
}

/** Two-file fixture manifest used across tests. */
function fixtureManifest(): {
  manifest: ReadonlyArray<ModelPin>;
  bytes: Record<string, Buffer>;
} {
  const onnxBytes = Buffer.from("FAKE-ONNX-BYTES-FOR-TESTS");
  const tokenizerBytes = Buffer.from('{"tokenizer":"fake"}');
  const onnxUrl = "https://example.test/model_quantized.onnx";
  const tokUrl = "https://example.test/tokenizer.json";

  const manifest: ReadonlyArray<ModelPin> = [
    {
      id: "test-model-a",
      description: "Test model A",
      files: [
        {
          filename: "model_quantized.onnx",
          url: onnxUrl,
          sha256: sha256(onnxBytes),
          approxBytes: onnxBytes.length,
        },
        {
          filename: "tokenizer.json",
          url: tokUrl,
          sha256: sha256(tokenizerBytes),
          approxBytes: tokenizerBytes.length,
        },
      ],
    },
    {
      id: "test-model-b",
      description: "Test model B",
      files: [
        {
          filename: "model_quantized.onnx",
          url: "https://example.test/b/model_quantized.onnx",
          sha256: sha256(onnxBytes),
        },
      ],
    },
  ];

  const bytes: Record<string, Buffer> = {
    [onnxUrl]: onnxBytes,
    [tokUrl]: tokenizerBytes,
    "https://example.test/b/model_quantized.onnx": onnxBytes,
  };
  return { manifest, bytes };
}

describe("parseSetupModelsArgv", () => {
  it("default: no embedders specified, no flags", () => {
    expect(parseSetupModelsArgv([])).toEqual({
      embedders: [],
      targetDir: null,
      force: false,
      allowDownload: false,
    });
  });

  it("--embedder <id> (space-separated)", () => {
    expect(parseSetupModelsArgv(["--embedder", "nomic-text-v1.5"])).toEqual({
      embedders: ["nomic-text-v1.5"],
      targetDir: null,
      force: false,
      allowDownload: false,
    });
  });

  it("--embedder=<id> (equals-form)", () => {
    expect(parseSetupModelsArgv(["--embedder=snowflake-arctic-embed-s"])).toEqual({
      embedders: ["snowflake-arctic-embed-s"],
      targetDir: null,
      force: false,
      allowDownload: false,
    });
  });

  it("multiple --embedder flags accumulate", () => {
    expect(
      parseSetupModelsArgv([
        "--embedder",
        "a",
        "--embedder=b",
        "--embedder",
        "c",
      ])
    ).toEqual({
      embedders: ["a", "b", "c"],
      targetDir: null,
      force: false,
      allowDownload: false,
    });
  });

  it("--target overrides target dir", () => {
    expect(parseSetupModelsArgv(["--target", "/tmp/foo"])).toEqual({
      embedders: [],
      targetDir: "/tmp/foo",
      force: false,
      allowDownload: false,
    });
    expect(parseSetupModelsArgv(["--target=/tmp/bar"])).toEqual({
      embedders: [],
      targetDir: "/tmp/bar",
      force: false,
      allowDownload: false,
    });
  });

  it("--force is recognised", () => {
    expect(parseSetupModelsArgv(["--force"]).force).toBe(true);
  });

  it("--allow-download is recognised", () => {
    expect(parseSetupModelsArgv(["--allow-download"]).allowDownload).toBe(true);
  });

  it("all flags together", () => {
    expect(
      parseSetupModelsArgv([
        "--embedder",
        "nomic-text-v1.5",
        "--target",
        "/tmp/x",
        "--force",
        "--allow-download",
      ])
    ).toEqual({
      embedders: ["nomic-text-v1.5"],
      targetDir: "/tmp/x",
      force: true,
      allowDownload: true,
    });
  });
});

describe("runSetupModels — consent gate (Gate 1)", () => {
  let tmp: string;
  let log: ReturnType<typeof vi.spyOn>;
  let err: ReturnType<typeof vi.spyOn>;
  const prevEnv = process.env.LODESTONE_ALLOW_MODEL_DOWNLOAD;
  const prevOffline = process.env.LODESTONE_OFFLINE;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "lodestone-setup-models-"));
    log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    delete process.env.LODESTONE_ALLOW_MODEL_DOWNLOAD;
    delete process.env.LODESTONE_OFFLINE;
  });
  afterEach(() => {
    log.mockRestore();
    err.mockRestore();
    rmSync(tmp, { recursive: true, force: true });
    if (prevEnv === undefined) delete process.env.LODESTONE_ALLOW_MODEL_DOWNLOAD;
    else process.env.LODESTONE_ALLOW_MODEL_DOWNLOAD = prevEnv;
    if (prevOffline === undefined) delete process.env.LODESTONE_OFFLINE;
    else process.env.LODESTONE_OFFLINE = prevOffline;
  });

  it("refuses without env or flag — exits 2 with clear message", async () => {
    const { manifest, bytes } = fixtureManifest();
    const fake = makeFakeFetch(bytes);
    const code = await runSetupModels(
      {
        embedders: ["test-model-a"],
        targetDir: tmp,
        force: false,
        allowDownload: false,
      },
      { fetchImpl: fake.fetch, manifest, cwd: tmp }
    );
    expect(code).toBe(2);
    const stderr = err.mock.calls.flat().join("\n");
    expect(stderr).toMatch(/explicit consent/i);
    expect(stderr).toMatch(/LODESTONE_ALLOW_MODEL_DOWNLOAD=1/);
    expect(stderr).toMatch(/--allow-download/);
    // No fetch attempted.
    expect(fake.calls).toEqual([]);
  });

  it("--allow-download flag alone is sufficient consent", async () => {
    const { manifest, bytes } = fixtureManifest();
    const fake = makeFakeFetch(bytes);
    const code = await runSetupModels(
      {
        embedders: ["test-model-a"],
        targetDir: tmp,
        force: false,
        allowDownload: true,
      },
      { fetchImpl: fake.fetch, manifest, cwd: tmp }
    );
    expect(code).toBe(0);
    expect(fake.calls.length).toBeGreaterThan(0);
  });

  it("LODESTONE_ALLOW_MODEL_DOWNLOAD=1 env var alone is sufficient consent", async () => {
    process.env.LODESTONE_ALLOW_MODEL_DOWNLOAD = "1";
    const { manifest, bytes } = fixtureManifest();
    const fake = makeFakeFetch(bytes);
    const code = await runSetupModels(
      {
        embedders: ["test-model-a"],
        targetDir: tmp,
        force: false,
        allowDownload: false,
      },
      { fetchImpl: fake.fetch, manifest, cwd: tmp }
    );
    expect(code).toBe(0);
  });

  it("LODESTONE_OFFLINE=1 blocks even with consent (Gate 2 — §18 chokepoint)", async () => {
    process.env.LODESTONE_OFFLINE = "1";
    const { manifest, bytes } = fixtureManifest();
    const fake = makeFakeFetch(bytes);
    const code = await runSetupModels(
      {
        embedders: ["test-model-a"],
        targetDir: tmp,
        force: false,
        allowDownload: true,
      },
      { fetchImpl: fake.fetch, manifest, cwd: tmp }
    );
    expect(code).toBe(1);
    const stderr = err.mock.calls.flat().join("\n");
    expect(stderr).toMatch(/offline/i);
    // Fetch was never reached.
    expect(fake.calls).toEqual([]);
  });
});

describe("runSetupModels — happy path", () => {
  let tmp: string;
  let log: ReturnType<typeof vi.spyOn>;
  let err: ReturnType<typeof vi.spyOn>;
  const prevEnv = process.env.LODESTONE_ALLOW_MODEL_DOWNLOAD;
  const prevOffline = process.env.LODESTONE_OFFLINE;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "lodestone-setup-models-"));
    log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    delete process.env.LODESTONE_ALLOW_MODEL_DOWNLOAD;
    delete process.env.LODESTONE_OFFLINE;
  });
  afterEach(() => {
    log.mockRestore();
    err.mockRestore();
    rmSync(tmp, { recursive: true, force: true });
    if (prevEnv === undefined) delete process.env.LODESTONE_ALLOW_MODEL_DOWNLOAD;
    else process.env.LODESTONE_ALLOW_MODEL_DOWNLOAD = prevEnv;
    if (prevOffline === undefined) delete process.env.LODESTONE_OFFLINE;
    else process.env.LODESTONE_OFFLINE = prevOffline;
  });

  it("downloads + verifies + writes both files for one embedder", async () => {
    const { manifest, bytes } = fixtureManifest();
    const fake = makeFakeFetch(bytes);
    const code = await runSetupModels(
      {
        embedders: ["test-model-a"],
        targetDir: tmp,
        force: false,
        allowDownload: true,
      },
      { fetchImpl: fake.fetch, manifest, cwd: tmp }
    );
    expect(code).toBe(0);
    const onnxPath = path.join(tmp, "test-model-a", "model_quantized.onnx");
    const tokPath = path.join(tmp, "test-model-a", "tokenizer.json");
    expect(existsSync(onnxPath)).toBe(true);
    expect(existsSync(tokPath)).toBe(true);
    expect(readFileSync(onnxPath).toString()).toBe("FAKE-ONNX-BYTES-FOR-TESTS");
    expect(fake.calls).toHaveLength(2);
  });

  it("no embedder list = downloads everything in manifest", async () => {
    const { manifest, bytes } = fixtureManifest();
    const fake = makeFakeFetch(bytes);
    const code = await runSetupModels(
      {
        embedders: [],
        targetDir: tmp,
        force: false,
        allowDownload: true,
      },
      { fetchImpl: fake.fetch, manifest, cwd: tmp }
    );
    expect(code).toBe(0);
    expect(existsSync(path.join(tmp, "test-model-a", "model_quantized.onnx"))).toBe(true);
    expect(existsSync(path.join(tmp, "test-model-b", "model_quantized.onnx"))).toBe(true);
  });

  it("default target = <cwd>/.lodestone/models when not overridden", async () => {
    const { manifest, bytes } = fixtureManifest();
    const fake = makeFakeFetch(bytes);
    const code = await runSetupModels(
      {
        embedders: ["test-model-b"],
        targetDir: null,
        force: false,
        allowDownload: true,
      },
      { fetchImpl: fake.fetch, manifest, cwd: tmp }
    );
    expect(code).toBe(0);
    expect(
      existsSync(
        path.join(tmp, ".lodestone", "models", "test-model-b", "model_quantized.onnx")
      )
    ).toBe(true);
  });
});

describe("runSetupModels — idempotency + force", () => {
  let tmp: string;
  let log: ReturnType<typeof vi.spyOn>;
  let err: ReturnType<typeof vi.spyOn>;
  const prevEnv = process.env.LODESTONE_ALLOW_MODEL_DOWNLOAD;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "lodestone-setup-models-"));
    log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    delete process.env.LODESTONE_ALLOW_MODEL_DOWNLOAD;
  });
  afterEach(() => {
    log.mockRestore();
    err.mockRestore();
    rmSync(tmp, { recursive: true, force: true });
    if (prevEnv === undefined) delete process.env.LODESTONE_ALLOW_MODEL_DOWNLOAD;
    else process.env.LODESTONE_ALLOW_MODEL_DOWNLOAD = prevEnv;
  });

  it("pre-populated valid file is skipped (no re-download)", async () => {
    const { manifest, bytes } = fixtureManifest();
    const onnxBytes = bytes["https://example.test/model_quantized.onnx"];
    const tokBytes = bytes["https://example.test/tokenizer.json"];
    expect(onnxBytes).toBeDefined();
    expect(tokBytes).toBeDefined();

    // Pre-populate target with the exact-byte fixtures the manifest expects.
    const dir = path.join(tmp, "test-model-a");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "model_quantized.onnx"), onnxBytes!);
    writeFileSync(path.join(dir, "tokenizer.json"), tokBytes!);

    const fake = makeFakeFetch(bytes);
    const code = await runSetupModels(
      {
        embedders: ["test-model-a"],
        targetDir: tmp,
        force: false,
        allowDownload: true,
      },
      { fetchImpl: fake.fetch, manifest, cwd: tmp }
    );
    expect(code).toBe(0);
    // The load-bearing assertion: zero network calls because both files
    // matched their pinned sha256.
    expect(fake.calls).toEqual([]);
    // Files are still on disk, byte-equal to what we put there.
    expect(readFileSync(path.join(dir, "model_quantized.onnx"))).toEqual(onnxBytes);
  });

  it("pre-populated bad-bytes file is re-downloaded (sha256 mismatch path)", async () => {
    const { manifest, bytes } = fixtureManifest();
    const dir = path.join(tmp, "test-model-a");
    mkdirSync(dir, { recursive: true });
    // Wrong bytes — the existing-file sha check will fail.
    writeFileSync(path.join(dir, "model_quantized.onnx"), Buffer.from("BAD"));
    writeFileSync(path.join(dir, "tokenizer.json"), Buffer.from("ALSO-BAD"));

    const fake = makeFakeFetch(bytes);
    const code = await runSetupModels(
      {
        embedders: ["test-model-a"],
        targetDir: tmp,
        force: false,
        allowDownload: true,
      },
      { fetchImpl: fake.fetch, manifest, cwd: tmp }
    );
    expect(code).toBe(0);
    expect(fake.calls).toHaveLength(2);
    // Bytes are now the verified ones from the fixture.
    expect(readFileSync(path.join(dir, "model_quantized.onnx")).toString()).toBe(
      "FAKE-ONNX-BYTES-FOR-TESTS"
    );
  });

  it("--force re-downloads even when files are valid", async () => {
    const { manifest, bytes } = fixtureManifest();
    const onnxBytes = bytes["https://example.test/model_quantized.onnx"]!;
    const tokBytes = bytes["https://example.test/tokenizer.json"]!;
    const dir = path.join(tmp, "test-model-a");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "model_quantized.onnx"), onnxBytes);
    writeFileSync(path.join(dir, "tokenizer.json"), tokBytes);

    const fake = makeFakeFetch(bytes);
    const code = await runSetupModels(
      {
        embedders: ["test-model-a"],
        targetDir: tmp,
        force: true,
        allowDownload: true,
      },
      { fetchImpl: fake.fetch, manifest, cwd: tmp }
    );
    expect(code).toBe(0);
    expect(fake.calls).toHaveLength(2);
  });
});

describe("runSetupModels — failure surfaces", () => {
  let tmp: string;
  let log: ReturnType<typeof vi.spyOn>;
  let err: ReturnType<typeof vi.spyOn>;
  const prevEnv = process.env.LODESTONE_ALLOW_MODEL_DOWNLOAD;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "lodestone-setup-models-"));
    log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    delete process.env.LODESTONE_ALLOW_MODEL_DOWNLOAD;
  });
  afterEach(() => {
    log.mockRestore();
    err.mockRestore();
    rmSync(tmp, { recursive: true, force: true });
    if (prevEnv === undefined) delete process.env.LODESTONE_ALLOW_MODEL_DOWNLOAD;
    else process.env.LODESTONE_ALLOW_MODEL_DOWNLOAD = prevEnv;
  });

  it("unknown embedder id exits 2 before any network call", async () => {
    const { manifest, bytes } = fixtureManifest();
    const fake = makeFakeFetch(bytes);
    const code = await runSetupModels(
      {
        embedders: ["does-not-exist"],
        targetDir: tmp,
        force: false,
        allowDownload: true,
      },
      { fetchImpl: fake.fetch, manifest, cwd: tmp }
    );
    expect(code).toBe(2);
    expect(fake.calls).toEqual([]);
    const stderr = err.mock.calls.flat().join("\n");
    expect(stderr).toMatch(/Unknown embedder id/);
    expect(stderr).toMatch(/does-not-exist/);
  });

  it("HTTP failure produces exit 1 and a clear message", async () => {
    const { manifest } = fixtureManifest();
    // Empty bytes table = every URL 404s.
    const fake = makeFakeFetch({});
    const code = await runSetupModels(
      {
        embedders: ["test-model-a"],
        targetDir: tmp,
        force: false,
        allowDownload: true,
      },
      { fetchImpl: fake.fetch, manifest, cwd: tmp }
    );
    expect(code).toBe(1);
    const stderr = err.mock.calls.flat().join("\n");
    expect(stderr).toMatch(/HTTP 404/);
  });

  it("fetched bytes failing sha256 are quarantined (not left on disk)", async () => {
    // Build a manifest where the pinned sha256 disagrees with the fixture
    // bytes — simulates a tampered mirror or wrong pin.
    const onnxBytes = Buffer.from("REAL-BYTES");
    const wrongSha = sha256(Buffer.from("DIFFERENT-BYTES"));
    const manifest: ReadonlyArray<ModelPin> = [
      {
        id: "tamper-test",
        description: "tampered fixture",
        files: [
          {
            filename: "model_quantized.onnx",
            url: "https://example.test/tamper.onnx",
            sha256: wrongSha,
          },
        ],
      },
    ];
    const bytes: Record<string, Buffer> = {
      "https://example.test/tamper.onnx": onnxBytes,
    };
    const fake = makeFakeFetch(bytes);
    const code = await runSetupModels(
      {
        embedders: ["tamper-test"],
        targetDir: tmp,
        force: false,
        allowDownload: true,
      },
      { fetchImpl: fake.fetch, manifest, cwd: tmp }
    );
    expect(code).toBe(1);
    const dest = path.join(tmp, "tamper-test", "model_quantized.onnx");
    // File MUST NOT remain on disk after a sha256 mismatch — defense
    // against a tampered mirror leaving bytes around for the next run to
    // accidentally trust.
    expect(existsSync(dest)).toBe(false);
    const stderr = err.mock.calls.flat().join("\n");
    expect(stderr).toMatch(/sha256 mismatch/);
  });
});

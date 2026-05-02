// SPDX-License-Identifier: Apache-2.0
//
// `lodestone setup-models` — opt-in friend-facing embedder fetcher.
//
// The default ship path bundles both `nomic-embed-text-v1.5` int8 and
// `snowflake-arctic-embed-s` int8 inside the published npm package
// (Section 05 POST-CODEX-001 amendment §1). For friends whose tarball
// omits the bundled weights (size-trimmed builds, mirror installs that
// stripped them, or future opt-in upgrades like `nomic-fp16`), this
// command provides a one-shot, consent-gated fetch path.
//
// Two-gate consent (load-bearing for the privacy promise):
//   1. Operator explicit opt-in:
//      `LODESTONE_ALLOW_MODEL_DOWNLOAD=1` env var OR `--allow-download`
//      flag. Without one of these, the command refuses to do anything
//      that touches the network.
//   2. Section 18 chokepoint:
//      `assertNetworkAllowed("setup-models: ...")` from
//      `@lodestone/shared` is the repo-wide gate. When
//      `LODESTONE_OFFLINE=1` is set, this throws and we exit non-zero.
//
// Both gates must say yes. The env+flag gate is operator intent;
// the chokepoint is the repo-wide privacy enforcement.
//
// Per-project, not global: weights land at
// `<repoRoot>/.lodestone/models/<id>/`. Each friend's models stay in
// their own repo dir — no shared cache leaks between projects.
//
// Compliance: NIST 800-53 SC-7 (Boundary Protection), CM-7 (Least
// Functionality), AC-3 (Access Enforcement), SI-7 (Software/Firmware
// Integrity — sha256 verification); CMMC L2 SC.L2-3.13.5,
// SI.L2-3.14.1; SOC 2 CC6.6, CC7.2; ISO 27001 A.13.1.1, A.12.1.2;
// FedRAMP Moderate SC-7, SI-7.

import { createHash } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { assertNetworkAllowed } from "@lodestone/shared";

import { output } from "../ui/output.js";

/**
 * Embedder identities recognised by `setup-models`. Kept as an open string
 * union so future entries (e.g. `nomic-fp16`) can be added to MANIFEST
 * without a TypeScript surface change. Validated against MANIFEST at parse
 * time so unknown ids exit cleanly with a clear error.
 */
export type SetupModelId = string;

/**
 * Per-file pin: source URL + sha256 of the expected bytes + on-disk
 * filename inside the per-id model directory.
 *
 * The sha256 is verified post-download. A mismatch causes the file to be
 * deleted and the command exits non-zero. With `--force`, any pre-existing
 * file with a wrong sha256 is also re-downloaded.
 *
 * The placeholder sha256 strings here are intentionally invalid (64 zeros);
 * the friend-facing release will pin real digests. Tests inject a manifest
 * override so they can exercise both happy + mismatch paths deterministically.
 */
export interface ModelFilePin {
  filename: string;
  url: string;
  sha256: string;
  /** Approximate size for progress display; not load-bearing. */
  approxBytes?: number;
}

export interface ModelPin {
  id: SetupModelId;
  /** Friendly description for the help / progress lines. */
  description: string;
  files: ReadonlyArray<ModelFilePin>;
}

/**
 * Built-in pin manifest. Pinned URLs match what Section 05's snowflake
 * loader and the bundler script use. The sha256 strings here are
 * placeholders — the real digests will be filled at release time when the
 * bundler captures them. Until then, friends running setup-models against
 * the live URLs will get a clear sha256 mismatch error rather than silent
 * acceptance of arbitrary bytes.
 */
const PLACEHOLDER_SHA256 = "0".repeat(64);

export const MANIFEST: ReadonlyArray<ModelPin> = Object.freeze([
  {
    id: "nomic-text-v1.5",
    description: "Nomic Embed Text v1.5 (int8 quantized, 768d, default)",
    files: [
      {
        filename: "onnx/model_quantized.onnx",
        url: "https://huggingface.co/Xenova/nomic-embed-text-v1.5/resolve/main/onnx/model_quantized.onnx",
        sha256: PLACEHOLDER_SHA256,
        approxBytes: 138 * 1024 * 1024,
      },
      {
        filename: "tokenizer.json",
        url: "https://huggingface.co/Xenova/nomic-embed-text-v1.5/resolve/main/tokenizer.json",
        sha256: PLACEHOLDER_SHA256,
        approxBytes: 711 * 1024,
      },
      {
        filename: "config.json",
        url: "https://huggingface.co/Xenova/nomic-embed-text-v1.5/resolve/main/config.json",
        sha256: PLACEHOLDER_SHA256,
        approxBytes: 2 * 1024,
      },
    ],
  },
  {
    id: "snowflake-arctic-embed-s",
    description: "Snowflake Arctic Embed S (int8 quantized, 384d, low-RAM fallback)",
    files: [
      {
        filename: "onnx/model_quantized.onnx",
        url: "https://huggingface.co/Snowflake/snowflake-arctic-embed-s/resolve/main/onnx/model_quantized.onnx",
        sha256: PLACEHOLDER_SHA256,
        approxBytes: 33 * 1024 * 1024,
      },
      {
        filename: "tokenizer.json",
        url: "https://huggingface.co/Snowflake/snowflake-arctic-embed-s/resolve/main/tokenizer.json",
        sha256: PLACEHOLDER_SHA256,
        approxBytes: 711 * 1024,
      },
      {
        filename: "config.json",
        url: "https://huggingface.co/Snowflake/snowflake-arctic-embed-s/resolve/main/config.json",
        sha256: PLACEHOLDER_SHA256,
        approxBytes: 2 * 1024,
      },
    ],
  },
]);

export interface SetupModelsOptions {
  /** Explicit embedder ids; empty array means "all known ids". */
  embedders: ReadonlyArray<string>;
  /** Override per-id target dir; default = `<cwd>/.lodestone/models/<id>/`. */
  targetDir: string | null;
  /** Re-download even if the file is present and sha256 matches. */
  force: boolean;
  /** Per-invocation consent flag (env var is the other path). */
  allowDownload: boolean;
}

export function parseSetupModelsArgv(
  argv: readonly string[]
): SetupModelsOptions {
  const embedders: string[] = [];
  let targetDir: string | null = null;
  let force = false;
  let allowDownload = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--embedder") {
      const next = argv[i + 1];
      if (typeof next === "string" && next.length > 0 && !next.startsWith("--")) {
        embedders.push(next);
        i++;
      }
    } else if (typeof arg === "string" && arg.startsWith("--embedder=")) {
      embedders.push(arg.slice("--embedder=".length));
    } else if (arg === "--target") {
      const next = argv[i + 1];
      if (typeof next === "string" && next.length > 0 && !next.startsWith("--")) {
        targetDir = next;
        i++;
      }
    } else if (typeof arg === "string" && arg.startsWith("--target=")) {
      targetDir = arg.slice("--target=".length);
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "--allow-download") {
      allowDownload = true;
    }
  }

  return { embedders, targetDir, force, allowDownload };
}

/** Minimal fetch shape so tests can pass a stub without pulling Undici types. */
export type FetchLike = (
  url: string
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  body: ReadableStream<Uint8Array> | null;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

/** Test seam — lets unit tests override fetch + manifest deterministically. */
export interface SetupModelsDeps {
  fetchImpl?: FetchLike;
  manifest?: ReadonlyArray<ModelPin>;
  /** Override cwd for tests so we never write into the real project root. */
  cwd?: string;
}

/**
 * Compute sha256 of a file by streaming it through the hash. Avoids
 * loading 150 MB into memory for the verification step.
 */
function sha256File(filePath: string): string {
  const buf = readFileSync(filePath);
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Stream a fetch response body to disk. Falls back to `arrayBuffer()` when
 * `body` is null (e.g. some older fetch polyfills). Atomic via tmp+rename.
 */
async function downloadToFile(
  res: Awaited<ReturnType<FetchLike>>,
  destPath: string
): Promise<void> {
  const tmpPath = `${destPath}.tmp`;
  // Best-effort cleanup if a prior run died mid-stream.
  if (existsSync(tmpPath)) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore — rename below will overwrite or surface its own error
    }
  }

  if (res.body !== null) {
    // The Node 20+ `fetch` returns a web ReadableStream; convert to a Node
    // stream so we can pipe to a file write stream.
    const nodeStream = Readable.fromWeb(
      res.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>
    );
    await pipeline(nodeStream, createWriteStream(tmpPath));
  } else {
    // Polyfill / mock path — buffer to memory then write. Tests use this.
    const buf = Buffer.from(await res.arrayBuffer());
    const fs = await import("node:fs/promises");
    await fs.writeFile(tmpPath, buf);
  }

  renameSync(tmpPath, destPath);
}

interface FileResult {
  filename: string;
  status: "skipped-up-to-date" | "downloaded" | "verified" | "failed";
  detail?: string;
}

interface ModelResult {
  id: string;
  files: FileResult[];
  /** True iff every required file is present + sha256-verified. */
  ok: boolean;
}

/**
 * Process one embedder pin: ensure each file is present + sha256 matches.
 * Returns per-file outcomes so the caller can render a summary and decide
 * the exit code. Never throws on a per-file failure — the failure is
 * recorded and the command surfaces a non-zero exit.
 */
async function processModel(
  pin: ModelPin,
  opts: {
    targetDir: string;
    force: boolean;
    fetchImpl: FetchLike;
  }
): Promise<ModelResult> {
  mkdirSync(opts.targetDir, { recursive: true });
  const fileResults: FileResult[] = [];
  let ok = true;

  for (const file of pin.files) {
    const dest = path.join(opts.targetDir, file.filename);
    mkdirSync(path.dirname(dest), { recursive: true });
    const expected = file.sha256;

    // Idempotency: if the file is already present and sha matches the pin,
    // skip the download entirely. With --force, blow it away first.
    if (existsSync(dest) && !opts.force) {
      const actual = sha256File(dest);
      if (actual === expected) {
        fileResults.push({ filename: file.filename, status: "skipped-up-to-date" });
        output.info(`    ${file.filename}: already present (${formatBytes(statSync(dest).size)})`);
        continue;
      }
      // Present but wrong bytes → treat as needing re-download.
      output.warn(
        `    ${file.filename}: present but sha256 mismatch (have ${actual.slice(0, 12)}…, want ${expected.slice(0, 12)}…) — re-downloading`
      );
    }

    output.info(
      `    ${file.filename}: fetching${file.approxBytes ? ` (~${formatBytes(file.approxBytes)})` : ""}…`
    );
    try {
      const res = await opts.fetchImpl(file.url);
      if (!res.ok) {
        const detail = `HTTP ${res.status} ${res.statusText} from ${file.url}`;
        fileResults.push({ filename: file.filename, status: "failed", detail });
        output.error(`    ${file.filename}: download failed — ${detail}`);
        ok = false;
        continue;
      }
      await downloadToFile(res, dest);
      const actual = sha256File(dest);
      if (actual !== expected) {
        const detail = `sha256 mismatch (got ${actual}, expected ${expected})`;
        // Quarantine the bad bytes — never leave verified-bad content on disk.
        try {
          unlinkSync(dest);
        } catch {
          // ignore — message below tells the operator
        }
        fileResults.push({ filename: file.filename, status: "failed", detail });
        output.error(
          `    ${file.filename}: ${detail}. File removed; re-run with --force to retry.`
        );
        ok = false;
        continue;
      }
      fileResults.push({ filename: file.filename, status: "downloaded" });
      output.success(`    ${file.filename}: downloaded + verified`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      fileResults.push({ filename: file.filename, status: "failed", detail });
      output.error(`    ${file.filename}: ${detail}`);
      ok = false;
    }
  }

  return { id: pin.id, files: fileResults, ok };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Public API used by the CLI dispatcher. Tests call this with `deps` to
 * inject a fetch stub + manifest override + cwd.
 */
export async function runSetupModels(
  opts: SetupModelsOptions,
  deps: SetupModelsDeps = {}
): Promise<number> {
  const manifest = deps.manifest ?? MANIFEST;
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const cwd = deps.cwd ?? process.cwd();

  // Gate 1: operator explicit opt-in. Either env var OR the per-invocation
  // flag. Defense in depth — we want both a "set it once for the shell" path
  // and a "this single invocation only" path.
  const envConsent = process.env.LODESTONE_ALLOW_MODEL_DOWNLOAD === "1";
  const flagConsent = opts.allowDownload;
  if (!envConsent && !flagConsent) {
    output.error(
      "setup-models requires explicit consent to download embedder weights."
    );
    output.error(
      "Either set LODESTONE_ALLOW_MODEL_DOWNLOAD=1 in your environment, or"
    );
    output.error("re-run with the --allow-download flag.");
    output.error(
      "(Lodestone's privacy promise is opt-in network — see docs/PRIVACY.md.)"
    );
    return 2;
  }

  // Resolve the target list: caller-specified, else every id in MANIFEST.
  const wantedIds: string[] =
    opts.embedders.length > 0 ? [...opts.embedders] : manifest.map((m) => m.id);

  // Validate every requested id is in the manifest before we touch the
  // network; clean error surface > partial work.
  const known = new Set(manifest.map((m) => m.id));
  const unknown = wantedIds.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    output.error(`Unknown embedder id(s): ${unknown.join(", ")}`);
    output.error(`Known ids: ${manifest.map((m) => m.id).join(", ")}`);
    return 2;
  }

  // Gate 2: §18 chokepoint. This is the repo-wide privacy gate; even with
  // operator consent, LODESTONE_OFFLINE=1 wins. Both gates must permit.
  try {
    assertNetworkAllowed(
      "setup-models: download embedder weights from HuggingFace"
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    output.error(`setup-models blocked by offline mode: ${detail}`);
    return 1;
  }

  const baseTarget = opts.targetDir ?? path.join(cwd, ".lodestone", "models");
  output.info(`Setup target: ${baseTarget}`);
  output.info("");

  const results: ModelResult[] = [];
  for (const id of wantedIds) {
    const pin = manifest.find((m) => m.id === id);
    // The unknown-id check above guarantees pin is non-null here.
    if (!pin) continue;

    output.info(`Embedder: ${pin.id} — ${pin.description}`);
    const targetDir = path.join(baseTarget, pin.id);
    const result = await processModel(pin, {
      targetDir,
      force: opts.force,
      fetchImpl,
    });
    results.push(result);
    output.info("");
  }

  // Summary — friend reads this and knows whether to re-run.
  const allOk = results.every((r) => r.ok);
  const downloadedCount = results.reduce(
    (n, r) => n + r.files.filter((f) => f.status === "downloaded").length,
    0
  );
  const skippedCount = results.reduce(
    (n, r) => n + r.files.filter((f) => f.status === "skipped-up-to-date").length,
    0
  );
  const failedCount = results.reduce(
    (n, r) => n + r.files.filter((f) => f.status === "failed").length,
    0
  );

  if (allOk) {
    output.success(
      `setup-models complete: ${downloadedCount} downloaded, ${skippedCount} already present.`
    );
    return 0;
  }

  output.error(
    `setup-models finished with ${failedCount} failure(s). See messages above.`
  );
  return 1;
}

/**
 * CLI dispatcher entrypoint. Thin wrapper around `runSetupModels` so the
 * routing layer can call a `(argv) => Promise<number>` handler.
 */
export async function setupModels(argv: readonly string[]): Promise<number> {
  const opts = parseSetupModelsArgv(argv);
  return runSetupModels(opts);
}

#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Lodestone model bundler — closes the §05 POST-CODEX-001 amendment §1
// ship blocker that was originally deferred to §10/§20.
//
// Downloads BOTH bundled embedders into `packages/ingest/models/{nomic,snowflake}/`:
//   * `nomic-text-v1.5`  — `Xenova/nomic-embed-text-v1.5` quantized (768d, ~150 MB, default)
//   * `snowflake-arctic-embed-s` — `Xenova/snowflake-arctic-embed-xs` quantized (384d, ~33 MB, low-RAM fallback)
//
// Both directories receive: `model_quantized.onnx`, `tokenizer.json`,
// `tokenizer_config.json`, `config.json`. The runtime resolver in
// `src/embed/bundled-paths.ts` only requires `model_quantized.onnx` +
// `tokenizer.json`, but we fetch the configs too so the transformers.js
// loader has everything it needs without inferring defaults.
//
// === BUILD-TIME-ONLY NETWORK EXCEPTION ===
// This script intentionally bypasses `assertNetworkAllowed()` from
// `@lodestone/shared/net/fetch`. That chokepoint guards the FRIEND
// RUNTIME — the shipped npm package — and is what makes the privacy
// promise ("your code never leaves your machine") defensible. This
// bundler is a MAINTAINER-ONLY build pipeline step that runs ONCE
// before publish, on the maintainer's workstation, with explicit
// operator authorization. Friends never run it; they receive the
// pre-bundled weights via `npm install`.
//
// Idempotent: if a target file exists and its sha256 matches the pinned
// `models-manifest.json`, the download is skipped. On first successful
// run for a given model the script will (a) compute hashes and (b)
// write/update the manifest entry. Subsequent runs are pure verification.
//
// Compliance: NIST 800-53 SA-12 (Supply Chain), CM-7 (Least
// Functionality), CM-6 (Configuration Settings); CMMC L2 SC.L2-3.13.5;
// SOC 2 CC6.6; ISO 27001 A.13.1.1; FedRAMP Moderate SA-12.
//
// Supply-chain note: only `nomic-ai/*` text models and the Xenova-mirrored
// `Snowflake/snowflake-arctic-embed-{s,xs}` are approved here. Do NOT add
// `nomic-embed-code` or any Qwen-based model — banned per CMNDI rules
// (the friend product inherits that ban). See CLAUDE.md §4 + this repo's
// SUPPLY-CHAIN.md / docs/SUPPLY-CHAIN.md once present.
//
// Usage (maintainers only):
//
//   pnpm --filter @lodestone/ingest bundle-models
//   pnpm --filter @lodestone/ingest bundle-models -- --force    # re-download even if hashes match
//   pnpm --filter @lodestone/ingest bundle-models -- --update-manifest  # accept new hashes from a fresh download
//
// After this completes, `pnpm -r build` will copy `models/` into
// `packages/ingest/dist/models/` so the shipped package includes the
// weights.

import { createHash } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * @typedef {object} BundledFile
 * @property {string} filename     Local file name written under models/<dir>/
 * @property {string} remotePath   Path relative to the HF repo root
 */

/**
 * @typedef {object} BundledModel
 * @property {string} id           Lodestone embedder id (matches EmbedderId in src/embed/types.ts)
 * @property {string} dir          Subdir under packages/ingest/models/
 * @property {string} hfRepoId     Hugging Face repo id (org/name)
 * @property {string} hfRevision   Pinned git revision/tag/branch — keep `main` until we tag a release
 * @property {BundledFile[]} files Files to download
 */

/** @type {BundledModel[]} */
const MODELS = [
  {
    id: "nomic-text-v1.5",
    dir: "nomic",
    // 2026-05-03: switched from Xenova/nomic-embed-text-v1.5 (removed
    // from HF) to nomic-ai/nomic-embed-text-v1.5 (official org). Verified
    // sha256 of onnx/model_quantized.onnx is byte-identical to the
    // pre-existing locally-bundled file (Xenova was a re-host).
    hfRepoId: "nomic-ai/nomic-embed-text-v1.5",
    hfRevision: "main",
    files: [
      { filename: "onnx/model_quantized.onnx", remotePath: "onnx/model_quantized.onnx" },
      { filename: "tokenizer.json", remotePath: "tokenizer.json" },
      { filename: "tokenizer_config.json", remotePath: "tokenizer_config.json" },
      { filename: "config.json", remotePath: "config.json" },
    ],
  },
  {
    id: "snowflake-arctic-embed-s",
    dir: "snowflake",
    // 2026-05-03: switched from Xenova/snowflake-arctic-embed-xs
    // (removed from HF) to Snowflake/snowflake-arctic-embed-xs (official
    // org). Same onnx/model_quantized.onnx layout — INT8 quantized,
    // ~23 MB — fits the §05 low-RAM tier budget.
    hfRepoId: "Snowflake/snowflake-arctic-embed-xs",
    hfRevision: "main",
    files: [
      { filename: "onnx/model_quantized.onnx", remotePath: "onnx/model_quantized.onnx" },
      { filename: "tokenizer.json", remotePath: "tokenizer.json" },
      { filename: "tokenizer_config.json", remotePath: "tokenizer_config.json" },
      { filename: "config.json", remotePath: "config.json" },
    ],
  },
];

const HERE = path.dirname(fileURLToPath(import.meta.url));
// scripts/ -> packages/ingest/
const PACKAGE_ROOT = path.resolve(HERE, "..");
const MODELS_ROOT = path.join(PACKAGE_ROOT, "models");
const MANIFEST_PATH = path.join(PACKAGE_ROOT, "models-manifest.json");

const HF_BASE = "https://huggingface.co";

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const FORCE = argv.includes("--force");
const UPDATE_MANIFEST = argv.includes("--update-manifest");

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Read existing manifest, or empty if absent. */
function readManifest() {
  if (!existsSync(MANIFEST_PATH)) {
    return {
      generatedAt: null,
      note: "Pinned sha256 hashes for bundled embedder weights. Updated by scripts/bundle-models.mjs --update-manifest.",
      models: {},
    };
  }
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  } catch (err) {
    throw new Error(`Failed to parse ${MANIFEST_PATH}: ${err.message}`);
  }
}

function writeManifest(manifest) {
  manifest.generatedAt = new Date().toISOString();
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

/** sha256-hex of a file. */
function sha256File(filePath) {
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  return hash.digest("hex");
}

function fmtBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

/**
 * Stream a remote URL into a local file. Uses native global `fetch` (Node 20+).
 * Throws on non-2xx. NOT routed through `assertNetworkAllowed()` — see header
 * comment for the build-time-only exception rationale.
 */
async function downloadTo(url, destPath) {
  const tmpPath = `${destPath}.partial`;
  const headers = {
    // Identify ourselves to the HF CDN for traceability.
    "user-agent": "lodestone-bundle-models/0.1 (+https://github.com/cmnd-institute/lodestone)",
  };
  // 2026-05-03: HF now requires auth for model downloads even on public
  // repos. Read token from $HF_TOKEN env first, then fall back to the
  // huggingface-cli cache file. Maintainer-only (this script never runs
  // on a friend machine).
  const hfToken =
    process.env.HF_TOKEN ||
    process.env.HUGGING_FACE_HUB_TOKEN ||
    (() => {
      try {
        const fs = require("node:fs");
        const path = require("node:path");
        const cacheToken = path.join(
          process.env.HOME || "/root",
          ".cache",
          "huggingface",
          "token",
        );
        return fs.existsSync(cacheToken) ? fs.readFileSync(cacheToken, "utf8").trim() : null;
      } catch {
        return null;
      }
    })();
  if (hfToken) {
    headers.Authorization = `Bearer ${hfToken}`;
  }
  const res = await fetch(url, {
    headers,
    // Default redirect handling is fine — HF returns a 302 to the CDN.
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  }
  if (!res.body) {
    throw new Error(`Empty response body for ${url}`);
  }

  // Stream to disk to avoid loading multi-hundred-MB ONNX weights into RAM.
  await new Promise((resolve, reject) => {
    const out = createWriteStream(tmpPath);
    out.on("error", reject);
    out.on("finish", resolve);
    // Web ReadableStream -> Node Writable. Node 18+ has Readable.fromWeb on
    // node:stream; we use the simple async iterator path for clarity.
    (async () => {
      try {
        for await (const chunk of res.body) {
          if (!out.write(chunk)) {
            await new Promise((r) => out.once("drain", r));
          }
        }
        out.end();
      } catch (err) {
        out.destroy(err);
      }
    })();
  });

  // Atomic-ish rename so a partial file from a crashed run is never accepted.
  const { renameSync } = await import("node:fs");
  renameSync(tmpPath, destPath);
}

function hfFileUrl(repoId, revision, remotePath) {
  // `resolve/` is the canonical CDN-redirecting endpoint for raw file bytes.
  return `${HF_BASE}/${repoId}/resolve/${encodeURIComponent(revision)}/${remotePath}`;
}

// ---------------------------------------------------------------------------
// Per-file fetch + verify
// ---------------------------------------------------------------------------

/**
 * Returns one of: "ok" | "downloaded" | "hash-mismatch".
 * Mutates `manifestEntry` in place when a new hash is recorded under
 * `--update-manifest` mode (or first time when no manifest exists).
 */
async function ensureFile(model, file, manifestEntry) {
  const destDir = path.join(MODELS_ROOT, model.dir);
  mkdirSync(destDir, { recursive: true });
  const destPath = path.join(destDir, file.filename);
  // file.filename may include a subdir (`onnx/model_quantized.onnx`); ensure it.
  mkdirSync(path.dirname(destPath), { recursive: true });

  const expectedHash = manifestEntry.files?.[file.filename]?.sha256 ?? null;

  // Fast-path: file present + manifest hash present + matches => skip.
  if (existsSync(destPath) && expectedHash && !FORCE) {
    const have = sha256File(destPath);
    if (have === expectedHash) {
      const size = statSync(destPath).size;
      console.log(`  [ok]   ${model.dir}/${file.filename}  (${fmtBytes(size)}, sha256 verified)`);
      return "ok";
    }
    if (!UPDATE_MANIFEST) {
      console.error(
        `  [FAIL] ${model.dir}/${file.filename}  hash mismatch:\n` +
        `         expected ${expectedHash}\n` +
        `         got      ${have}\n` +
        `         Re-run with --force to re-download, or --update-manifest if ` +
        `you intentionally bumped the model revision.`
      );
      return "hash-mismatch";
    }
    // fall through to re-download because operator wants a manifest refresh
  }

  const url = hfFileUrl(model.hfRepoId, model.hfRevision, file.remotePath);
  console.log(`  [pull] ${model.dir}/${file.filename}  <- ${url}`);
  const t0 = Date.now();
  await downloadTo(url, destPath);
  const elapsedMs = Date.now() - t0;
  const size = statSync(destPath).size;
  const got = sha256File(destPath);

  console.log(
    `         done  ${fmtBytes(size)} in ${(elapsedMs / 1000).toFixed(1)}s  sha256=${got.slice(0, 16)}…`
  );

  if (expectedHash && got !== expectedHash && !UPDATE_MANIFEST) {
    console.error(
      `  [FAIL] ${model.dir}/${file.filename}  downloaded hash differs from pinned manifest.\n` +
      `         expected ${expectedHash}\n` +
      `         got      ${got}\n` +
      `         If you intend to update the pinned weights, re-run with --update-manifest.`
    );
    return "hash-mismatch";
  }

  // Record/refresh manifest entry for this file.
  manifestEntry.files = manifestEntry.files ?? {};
  manifestEntry.files[file.filename] = {
    sha256: got,
    sizeBytes: size,
    sourceUrl: url,
  };
  return "downloaded";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`lodestone bundle-models — target dir: ${MODELS_ROOT}`);
  if (FORCE) console.log("  flag: --force (re-download even if hashes match)");
  if (UPDATE_MANIFEST) console.log("  flag: --update-manifest (accept new hashes)");

  mkdirSync(MODELS_ROOT, { recursive: true });
  const manifest = readManifest();
  manifest.models = manifest.models ?? {};

  let totalDownloaded = 0;
  let failures = 0;

  for (const model of MODELS) {
    console.log(`\n[${model.id}]  ${model.hfRepoId} @ ${model.hfRevision}`);
    const entry = (manifest.models[model.id] = manifest.models[model.id] ?? {
      hfRepoId: model.hfRepoId,
      hfRevision: model.hfRevision,
      files: {},
    });
    // Keep manifest's pinned repo metadata in sync with the script (so
    // `--update-manifest` after a repo/revision swap reflects the new source).
    entry.hfRepoId = model.hfRepoId;
    entry.hfRevision = model.hfRevision;

    for (const file of model.files) {
      try {
        const status = await ensureFile(model, file, entry);
        if (status === "downloaded") totalDownloaded++;
        if (status === "hash-mismatch") failures++;
      } catch (err) {
        console.error(`  [FAIL] ${model.dir}/${file.filename}: ${err.message}`);
        failures++;
      }
    }
  }

  // Persist manifest if (a) it didn't exist yet, or (b) operator passed
  // --update-manifest, or (c) we downloaded any new files (so the first-ever
  // run lands a usable manifest).
  const manifestExisted = existsSync(MANIFEST_PATH);
  if (failures === 0 && (!manifestExisted || UPDATE_MANIFEST || totalDownloaded > 0)) {
    writeManifest(manifest);
    console.log(`\nWrote manifest: ${MANIFEST_PATH}`);
  }

  console.log(
    `\nSummary: ${totalDownloaded} file(s) downloaded, ${failures} failure(s).`
  );

  if (failures > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\nFATAL:", err.stack || err.message || err);
  process.exit(1);
});

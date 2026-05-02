// SPDX-License-Identifier: Apache-2.0
// Resolve the on-disk directory holding ONNX weights for a given embedder.
// Works in dev (source tree under packages/ingest/models/), in built form
// (packages/ingest/dist/models/), and when consumed via node_modules.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { EmbedderId } from "./types.js";

/**
 * Where the package root lives on disk, regardless of whether the importing
 * code is in src/, dist/, or node_modules/@lodestone/ingest/dist/.
 *
 * NodeNext ESM: `import.meta.url` resolves to this file. Walking two dirs up
 * from `embed/` lands at the package root in both src/ and dist/.
 */
function packageRoot(): string {
  const here = fileURLToPath(import.meta.url);
  // here = .../packages/ingest/{src,dist}/embed/bundled-paths.{ts,js}
  return path.resolve(path.dirname(here), "..", "..");
}

const ID_TO_DIR: Record<EmbedderId, string> = {
  "nomic-text-v1.5": "nomic",
  "snowflake-arctic-embed-s": "snowflake",
};

/**
 * Required filenames for a model dir to count as "present." Tokenizer config
 * is optional (some bundles inline it into tokenizer.json).
 */
const REQUIRED_FILES = ["model_quantized.onnx", "tokenizer.json"] as const;

export class EmbedderLoadError extends Error {
  constructor(message: string, public readonly hint?: string) {
    super(hint ? `${message}\nHint: ${hint}` : message);
    this.name = "EmbedderLoadError";
  }
}

function dirHasModel(dir: string): boolean {
  return REQUIRED_FILES.every((f) => existsSync(path.join(dir, f)));
}

/**
 * Resolve the bundled model dir for `id`. Search order:
 *   1. `<packageRoot>/dist/models/<id>/` — deployed build location.
 *   2. `<packageRoot>/models/<id>/` — local dev tree.
 * Throws EmbedderLoadError if neither is present, with a hint pointing at
 * the bundler step (Section 10/20) that's responsible for populating it.
 */
export function resolveBundledModelDir(id: EmbedderId): string {
  const subdir = ID_TO_DIR[id];
  if (!subdir) {
    throw new EmbedderLoadError(`Unknown embedder id: ${id}`);
  }
  const root = packageRoot();
  const distPath = path.join(root, "dist", "models", subdir);
  if (dirHasModel(distPath)) return distPath;
  const devPath = path.join(root, "models", subdir);
  if (dirHasModel(devPath)) return devPath;

  throw new EmbedderLoadError(
    `Bundled model not found for ${id}`,
    `Expected ${REQUIRED_FILES.join(" + ")} under ${distPath} ` +
      `(deployed build) or ${devPath} (dev tree). The bundler script in ` +
      `Section 10/20 produces these. For local dev, run the model-fetch ` +
      `helper to populate ${devPath}.`
  );
}

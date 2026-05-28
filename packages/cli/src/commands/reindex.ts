// SPDX-License-Identifier: Apache-2.0
// `lodestone reindex` — POST-§20 Issue C. Drives the full §05–§11 ingest
// pipeline against the current cwd: walk → parse → resolve → graph →
// pagerank → cluster → seed-skills → embeddings → ready.json. Used as a
// standalone refresh command AND called internally by `lodestone init`
// (per Option C: single-command happy path + named refresh handle).
//
// Compliance: NIST 800-53 SI-7 (atomic readiness marker), AU-2 (audit-ready
// counts surfaced on stdout), CM-6 (embedder identity captured in ready.json);
// CMMC L2 SI.L2-3.14.1; SOC 2 CC7.2; ISO 27001 A.12.1.2; FedRAMP Mod SI-7.

import type { PipelineSummary } from "@lodestone/ingest";
import type { EmbedderHandle, LoadOptions } from "@lodestone/ingest/embed";
import type { LodestoneConfig } from "@lodestone/shared";
import { loadConfig } from "../config/load.js";
import { output } from "../ui/output.js";

/**
 * Test seam — lets unit tests inject a deterministic embedder loader without
 * pulling the real nomic/snowflake weights. Production calls `load()`.
 * Cleared by tests in afterEach via `__setEmbedderLoaderForTests(null)`.
 */
type EmbedderLoader = (opts?: LoadOptions) => Promise<EmbedderHandle>;
let testLoader: EmbedderLoader | null = null;

export function __setEmbedderLoaderForTests(loader: EmbedderLoader | null): void {
  testLoader = loader;
}

async function loadEmbedder(opts: LoadOptions = {}): Promise<EmbedderHandle> {
  if (testLoader !== null) return testLoader(opts);
  // Lazy dynamic import so `lodestone init --no-reindex` does NOT pay the
  // graphology / better-sqlite3 / onnxruntime load cost (or trip on
  // graphology's CJS-named-export ESM interop quirk under Node).
  const mod = (await import("@lodestone/ingest/embed")) as {
    load: (opts?: LoadOptions) => Promise<EmbedderHandle>;
  };
  return mod.load(opts);
}

export interface ReindexOptions {
  /** Don't actually run; just print what would happen. */
  dryRun: boolean;
  /** Print command help without touching the index. */
  help: boolean;
}

export function parseReindexArgv(argv: readonly string[]): ReindexOptions {
  return {
    dryRun: argv.includes("--dry-run"),
    help: argv.includes("--help") || argv.includes("-h"),
  };
}

export function printReindexHelp(): void {
  console.log(
    [
      "lodestone reindex — rebuild this project's Lodestone index.",
      "",
      "USAGE",
      "  lodestone reindex [--dry-run]",
      "  lodestone reindex --help",
      "",
      "OPTIONS",
      "  --dry-run   Show what would happen without touching .lodestone/.",
      "  -h, --help  Show this help message.",
      "",
      "CONFIG",
      "  Reads .lodestone/lodestone.toml before loading the embedder.",
      "  [embedder].profile = \"tiny\" pins snowflake-arctic-embed-s for index-time embeddings.",
    ].join("\n")
  );
}

export function embedderLoadOptionsForProfile(
  profile: LodestoneConfig["embedder"]["profile"]
): LoadOptions {
  if (process.env.LODESTONE_EMBEDDER) return {};
  if (profile === "tiny") return { force: "snowflake-arctic-embed-s" };
  return {};
}

/**
 * Embedder identity used in ready.json. The runtime `EmbedderHandle` shape
 * doesn't carry `quant`, so the loader caller passes it explicitly. v0 ships
 * nomic-text-v1.5 and snowflake-arctic-embed-s. The exact quant tag isn't
 * load-bearing for v0 status — when the
 * runtime gains a `quant` getter on EmbedderHandle, plumb it through here.
 */
function identityFor(id: string, dim: number): { id: string; dim: number; quant: string } {
  return { id, dim, quant: "fp32" };
}

/**
 * Run the ingest pipeline against `repoRoot`. Exposed for testability — both
 * `reindex` and `init` delegate here. Does NOT write any install side-effects
 * (init handles those before calling runReindex).
 */
export async function runReindex(repoRoot: string): Promise<PipelineSummary> {
  const config = await loadConfig(repoRoot);
  const embedderOptions = embedderLoadOptionsForProfile(config.embedder.profile);
  output.info("Loading embedder…");
  const embedder = await loadEmbedder(embedderOptions);
  try {
    output.info(`Indexing repository at ${repoRoot}`);
    // Lazy import — see loadEmbedder() comment.
    const { runPipeline } = (await import("@lodestone/ingest")) as {
      runPipeline: (opts: {
        repoRoot: string;
        embedder: EmbedderHandle;
        embedderIdentity: { id: string; dim: number; quant: string };
        onProgress?: (stage: string) => void;
      }) => Promise<PipelineSummary>;
    };
    const summary = await runPipeline({
      repoRoot,
      embedder,
      embedderIdentity: identityFor(embedder.id, embedder.dim),
      onProgress: (stage) => {
        // Keep progress chatter low-noise but visible — friend running init
        // shouldn't see a stalled terminal.
        output.info(`  • ${stage}`);
      },
    });
    output.success("Reindex complete.");
    output.info(`  files parsed:        ${summary.filesParsed}`);
    output.info(`  symbols indexed:     ${summary.symbolCount}`);
    output.info(`  edges (resolved):    ${summary.edgeCount}`);
    output.info(`  unresolved targets:  ${summary.unresolvedEdgeNames}`);
    output.info(`  file-level imports dropped: ${summary.droppedEdgeCount}`);
    output.info(`  clusters:            ${summary.clusterCount}`);
    output.info(`  seed skills:         ${summary.skillCount}`);
    output.info(`  embeddings:          ${summary.embeddingCount}`);
    if (summary.filesParsed === 0) {
      // Friend-mode footgun: curl-bash installer run in an empty or wrong dir
      // (Downloads/, ~/, scratch) silently produces an empty KG. Surface a
      // visible hint so the next-step editor agent doesn't conclude Lodestone
      // is broken. Exit code stays 0 — advisory only.
      output.warn(
        "0 source files were parsed — did you mean to run `lodestone init` inside a code directory? " +
          "Lodestone looks for .ts/.tsx/.js/.jsx/.mjs/.cjs/.py/.pyi/.go/.rs files (configurable in lodestone.toml).",
      );
    }
    return summary;
  } finally {
    try {
      await embedder.dispose();
    } catch {
      // best-effort — never let a teardown error overshadow the success path
    }
  }
}

export async function reindex(argv: readonly string[]): Promise<number> {
  const opts = parseReindexArgv(argv);
  const cwd = process.cwd();

  if (opts.help) {
    printReindexHelp();
    return 0;
  }

  if (opts.dryRun) {
    output.info("--dry-run set; would walk + parse + embed + persist under .lodestone/.");
    return 0;
  }

  try {
    await runReindex(cwd);
    return 0;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    output.error(`Reindex failed: ${detail}`);
    if (isBundledModelMissing(err)) {
      output.error("");
      output.error(
        "Hint: bundled embedder weights are missing. Run `lodestone setup-models --allow-download`"
      );
      output.error(
        "to fetch them on demand (consent-gated, see docs/PRIVACY.md)."
      );
    }
    return 1;
  }
}

/**
 * Detect the §05 EmbedderLoadError that signals "bundled weights are not
 * on disk." We match by message content rather than instanceof so that the
 * detection survives ESM dual-instance wrinkles between the cli and ingest
 * package boundaries (each can import its own copy of the class).
 */
export function isBundledModelMissing(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /Bundled model not found/i.test(err.message);
}

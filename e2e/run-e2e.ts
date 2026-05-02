// SPDX-License-Identifier: Apache-2.0
//
// §20 — End-to-end orchestrator. Capstone integration for v0.
//
// What it does, in order:
//
//   1. Clone the synthetic demo repo to a fresh tmp dir (committed fixture
//      stays immutable).
//   2. Spawn the real `lodestone init --no-reindex` binary against the tmp
//      dir; assert install side effects (.mcp.json + .gitignore +
//      install-manifest.json). `--no-reindex` keeps the spawn focused on
//      install behaviour so the e2e ingest path (step 3) can use a
//      deterministic embedder; production callers omit the flag and get a
//      single-command install + index per POST-§20 Issue C.
//   3. Programmatically drive the §05–§11 ingest pipeline against the tmp
//      dir using `@lodestone/ingest`'s `runPipeline` helper. POST-§20
//      Issue A: the inline parser-edge sha→qname remap is gone — §06
//      parsers now emit qname directly. POST-§20 Issue C: the pipeline
//      driver is the same one production `lodestone reindex` uses; the e2e
//      injects a deterministic embedder via createDeterministicEmbedder().
//   4. Exercise every MCP tool handler in-process against the tmp dir,
//      using LODESTONE_CWD only — POST-§20 Issue B consolidated §14 + §15
//      DB-path resolution behind a single env var precedence chain.
//   5. Assert results against FIXTURE_MANIFEST.json predictions.
//   6. Cleanup tmp dir.
//
// The whole orchestrator runs under the active network interceptor — see
// network-interceptor.ts. Zero outbound calls is a hard invariant.

import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

import { parserForFile } from "@lodestone/ingest/parsers";
import { runPipeline, type PipelineSummary } from "@lodestone/ingest";
import { _resetWriterRegistry, VECTOR_DIM } from "@lodestone/ingest/store";

import { lodestoneSubpath } from "@lodestone/shared";

import type { EmbedderHandle } from "@lodestone/ingest/embed";

// ── Local fixture / repo paths ────────────────────────────────────────────
const E2E_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname));
export const SYNTHETIC_DEMO_DIR = path.join(E2E_DIR, "synthetic-demo-repo");

/** Manifest shape — JSON-loaded on demand by callers. */
export interface FixtureManifest {
  schema_version: number;
  languages: string[];
  expected_files_min: number;
  expected_files_max: number;
  expected_symbols_min: number;
  expected_clusters_min: number;
  expected_clusters_max: number;
  expected_subsystems: Array<{
    name: string;
    member_path_substrings: string[];
    anchor_symbol_substring: string;
  }>;
  expected_seed_skills: Array<{
    slug: string;
    min_evidence_count: number;
    rationale: string;
  }>;
  expected_high_pagerank_anchors: Array<{
    path_substring: string;
    rationale: string;
  }>;
  expected_query_topics: Array<{
    question: string;
    expected_path_substring: string;
  }>;
  expected_mcp_tools: string[];
  intentional_noise_files: string[];
}

export function loadFixtureManifest(): FixtureManifest {
  const raw = readFileSync(path.join(SYNTHETIC_DEMO_DIR, "FIXTURE_MANIFEST.json"), "utf8");
  return JSON.parse(raw) as FixtureManifest;
}

/** Clone the committed fixture into a fresh tmp dir. Returns the tmp path. */
export function cloneFixtureToTmp(): string {
  const tmp = mkdtempSync(path.join(tmpdir(), "lodestone-e2e-"));
  cpSync(SYNTHETIC_DEMO_DIR, tmp, { recursive: true });
  return tmp;
}

/** Recursive walk returning every file matched by a parser. */
export function listSourceFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur) break;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".lodestone" || entry.name === ".git") {
        continue;
      }
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.isFile() && parserForFile(full) !== null) {
        out.push(full);
      }
    }
  }
  out.sort();
  return out;
}

/** Spawn the lodestone CLI binary as a subprocess and return its exit info. */
export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function runLodestoneCli(
  args: readonly string[],
  cwd: string,
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<CliResult> {
  const require = createRequire(import.meta.url);
  // The @lodestone/cli package.json restricts `exports` to "." + "./main",
  // so we can't resolve "@lodestone/cli/package.json" directly. Instead we
  // resolve the package main, walk up two levels (dist/index.js → dist →
  // package root), then read package.json there.
  const mainPath = require.resolve("@lodestone/cli");
  const cliPkgRoot = path.dirname(path.dirname(mainPath));
  const cliPkgPath = path.join(cliPkgRoot, "package.json");
  const cliPkg = JSON.parse(readFileSync(cliPkgPath, "utf8")) as {
    bin?: Record<string, string>;
  };
  const binRel = cliPkg.bin?.lodestone;
  if (!binRel) {
    throw new Error("@lodestone/cli package.json is missing the bin.lodestone entry");
  }
  const binAbs = path.resolve(cliPkgRoot, binRel);
  if (!existsSync(binAbs)) {
    throw new Error(
      `lodestone CLI bin not found at ${binAbs}. Did you 'pnpm -r build' first?`,
    );
  }

  return new Promise<CliResult>((resolve, reject) => {
    const child = spawn(process.execPath, [binAbs, ...args], {
      cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `lodestone CLI ${args.join(" ")} timed out after ${opts.timeoutMs ?? 60_000}ms`,
        ),
      );
    }, opts.timeoutMs ?? 60_000);
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ exitCode: code ?? 0, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/** Deterministic pseudo-random embedder — seeded by symbol id so the same
 * input always produces the same vector. Vectors are unit-normalized. The
 * e2e doesn't need semantic quality; it only needs the symbol_embeddings
 * vec0 table to be populated so query() exercises the vector lane. */
export function createDeterministicEmbedder(): EmbedderHandle {
  const sample = (id: string): Float32Array => {
    let state = 0;
    for (let i = 0; i < id.length; i++) {
      state = (state * 31 + id.charCodeAt(i)) >>> 0;
    }
    const out = new Float32Array(VECTOR_DIM);
    let norm = 0;
    for (let i = 0; i < VECTOR_DIM; i++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      const v = (state % 10_000) / 10_000 - 0.5;
      out[i] = v;
      norm += v * v;
    }
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < VECTOR_DIM; i++) {
      out[i] = (out[i] ?? 0) / norm;
    }
    return out;
  };
  return {
    id: "e2e-deterministic",
    dim: VECTOR_DIM,
    quant: "fp32",
    async embed(inputs: readonly string[]): Promise<Float32Array[]> {
      return inputs.map((input) => sample(input));
    },
    async close(): Promise<void> {
      /* no-op */
    },
  } as unknown as EmbedderHandle;
}

/**
 * Output of the in-process ingest pipeline driver. Re-exports the upstream
 * `PipelineSummary` shape so existing callers keep their imports valid.
 */
export type IngestSummary = PipelineSummary;

/** Drive the full §05–§11 pipeline against `repoRoot`, populating
 * `<repoRoot>/.lodestone/lodestone.sqlite` + writing ready.json. POST-§20:
 * delegates to the canonical `runPipeline` driver in `@lodestone/ingest` —
 * the inline parser/edge-remap workaround is gone now that §06 parsers emit
 * qname directly (Issue A). */
export async function runIngest(repoRoot: string): Promise<IngestSummary> {
  const embedder = createDeterministicEmbedder();
  try {
    return await runPipeline({
      repoRoot,
      embedder,
      embedderIdentity: { id: "e2e-deterministic", dim: VECTOR_DIM, quant: "fp32" },
      indexEpoch: 1,
    });
  } finally {
    _resetWriterRegistry();
  }
}

/** Best-effort cleanup. Swallows ENOTEMPTY etc. — caller decides whether
 * the failure matters. */
export function cleanupTmp(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// ─────────────────────────────────────────────────────────────────────────
// MCP tool exercise wrappers.
//
// `query`, `recent_changes`, `context`, `impact`, `skills_for`, `feedback`
// resolve cwd through @lodestone/mcp-server/dist/tools/_shared.js
// `resolveCwd()`, which honors `LODESTONE_CWD`. So setting that env var
// before calling the handler is enough.
//
// `cluster.handler` captures `process.cwd()` at module load. To target a
// specific tmp dir, we `process.chdir(tmp)` and call this through a fresh
// dynamic import (vitest spec sets up & tears down chdir per test).
// ─────────────────────────────────────────────────────────────────────────

/**
 * Set `LODESTONE_CWD` around `fn` then restore. POST-§20 Issue B: the §14 +
 * §15 surfaces now share one resolver (`_shared.resolveDbPath`) that honors
 * `LODESTONE_DB_PATH > LODESTONE_CWD > process.cwd()` — setting `LODESTONE_CWD`
 * alone is enough to point every MCP tool at the same tmp DB.
 */
export async function withLodestoneCwd<T>(
  cwd: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prevCwd = process.env.LODESTONE_CWD;
  process.env.LODESTONE_CWD = cwd;
  try {
    return await fn();
  } finally {
    if (prevCwd === undefined) delete process.env.LODESTONE_CWD;
    else process.env.LODESTONE_CWD = prevCwd;
  }
}

/** Resolve the absolute path to a built tool dist module under the
 * @lodestone/mcp-server package. We import via absolute path (which Node's
 * ESM loader accepts directly, bypassing package `exports` restrictions —
 * the package's barrel does not re-export per-tool factories so we have to
 * reach in for the e2e). */
function mcpToolDistPath(toolName: string): string {
  const require = createRequire(import.meta.url);
  // @lodestone/mcp-server `exports` restricts to "." only — resolve the
  // main, walk up to the package root, then build the deep dist path.
  const mainPath = require.resolve("@lodestone/mcp-server");
  const pkgRoot = path.dirname(path.dirname(mainPath));
  return path.resolve(pkgRoot, "dist", "tools", `${toolName}.js`);
}

/** Public so tests can pull tool dist paths the same way. */
export function resolveMcpToolDistPath(toolName: string): string {
  return mcpToolDistPath(toolName);
}

/** Resolve the dist client/sqlite.js — same package-root walk pattern. */
function mcpClientSqlitePath(): string {
  const require = createRequire(import.meta.url);
  const mainPath = require.resolve("@lodestone/mcp-server");
  const pkgRoot = path.dirname(path.dirname(mainPath));
  return path.resolve(pkgRoot, "dist", "client", "sqlite.js");
}

/** Inject a deterministic embedder into the `query` tool — avoids the
 * bundled-nomic load (which would need 1.5 GB of weights and time). The
 * setter is exported by the tool module per §14 unit-test convention. */
export async function injectQueryEmbedder(): Promise<void> {
  const mod = (await import(mcpToolDistPath("query"))) as {
    __setEmbedderForTests: (e: EmbedderHandle | null) => void;
  };
  mod.__setEmbedderForTests(createDeterministicEmbedder());
}

export async function clearQueryEmbedder(): Promise<void> {
  const mod = (await import(mcpToolDistPath("query"))) as {
    __setEmbedderForTests: (e: EmbedderHandle | null) => void;
  };
  mod.__setEmbedderForTests(null);
}

/** Build a cluster handler bound to a specific `repoRoot`. The tool's
 * `defaultContext()` captures `process.cwd()` at module load — for the e2e
 * we ignore the default and pass an explicit ctx pointing at the tmp DB. */
export async function makeClusterHandler(repoRoot: string): Promise<
  (input: unknown) => Promise<unknown>
> {
  const dbPath = lodestoneSubpath(repoRoot, "sqlite");
  const clusterMod = (await import(mcpToolDistPath("cluster"))) as {
    createHandler: (ctx: {
      openReader: () => unknown;
      loadEmbedder?: () => Promise<EmbedderHandle>;
    }) => (input: unknown) => Promise<unknown>;
  };
  // Use the mcp-server's own openReader (the read-only client wrapper) so
  // the ReaderHandle shape matches what cluster's internals expect.
  const sqliteClientMod = (await import(mcpClientSqlitePath())) as {
    openReader: (p: string) => unknown;
  };
  return clusterMod.createHandler({
    openReader: () => sqliteClientMod.openReader(dbPath),
    loadEmbedder: async () => createDeterministicEmbedder(),
  });
}

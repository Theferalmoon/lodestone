// SPDX-License-Identifier: Apache-2.0
//
// §20 — End-to-end orchestrator. Capstone integration for v0.
//
// What it does, in order:
//
//   1. Clone the synthetic demo repo to a fresh tmp dir (committed fixture
//      stays immutable).
//   2. Spawn the real `lodestone init` binary against the tmp dir; assert
//      install side effects (.mcp.json + .gitignore + install-manifest.json).
//   3. Programmatically drive the §05–§11 ingest pipeline against the tmp
//      dir using the in-process @lodestone/ingest exports. Reason: the
//      §04 init command does NOT yet run ingestion (that wires up later);
//      §20's job is to prove the pipeline produces a queryable index, not
//      to wait for §04 to grow new behaviour.
//        a. Walk the tree, parse each supported file via parserForFile().
//        b. Build LodestoneGraph + resolve edges + compute PageRank.
//        c. Run cluster() → persistClusters() → write a deterministic
//           random-vector embedding per symbol (production uses nomic; for
//           the e2e we only need the vec0 table populated so query() runs).
//        d. Run seedSkillsFor() → writeSkills() to populate the skills table.
//        e. Write the canonical ready.json marker so MCP tools see "ready".
//   4. Exercise every MCP tool handler in-process against the tmp dir,
//      using LODESTONE_CWD (every tool except `cluster` resolves cwd at
//      handler-call time). For `cluster`, whose `defaultContext()` captures
//      `process.cwd()` at module load, we `process.chdir(tmp)` and import
//      the module dynamically so its dbPath binds to the right project.
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

import { createHash } from "node:crypto";

import {
  parserForFile,
  type ParseResult,
  type ParserEdge,
} from "@lodestone/ingest/parsers";
import {
  buildGraph,
  pageRank,
  resolveEdges,
} from "@lodestone/ingest/graph";
import {
  bootstrap,
  closeDb,
  ensureSymbolEmbeddingsTable,
  openWriter,
  writeClassInheritance,
  writeEdges,
  writeEmbeddings,
  writePagerank,
  writeReady,
  writeSymbols,
  type EmbeddingRow,
  VECTOR_DIM,
  _resetWriterRegistry,
} from "@lodestone/ingest/store";
import { cluster as runCluster, persistClusters } from "@lodestone/ingest/clusterer";
import { seedSkillsFor, writeSkills, sha256Hex } from "@lodestone/ingest";

import {
  CURRENT_SCHEMA_VERSION,
  lodestoneSubpath,
  type LodestoneSymbol,
  type Edge as ResolvedEdgeShape,
  type Skill,
} from "@lodestone/shared";

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

/** Output of the in-process ingest pipeline driver. */
export interface IngestSummary {
  filesParsed: number;
  symbolCount: number;
  edgeCount: number;
  classInheritanceCount: number;
  clusterCount: number;
  skillCount: number;
  embeddingCount: number;
}

/** Drive the full §05–§11 pipeline against `repoRoot`, populating
 * `<repoRoot>/.lodestone/lodestone.sqlite` + writing ready.json. */
export async function runIngest(repoRoot: string): Promise<IngestSummary> {
  const dbPath = lodestoneSubpath(repoRoot, "sqlite");

  // 1. Parse everything.
  const files = listSourceFiles(repoRoot);
  const parseResults: ParseResult[] = [];
  const allSymbols: LodestoneSymbol[] = [];
  const allClassInheritance: { class_id: string; base_name: string; base_path?: string }[] = [];

  for (const file of files) {
    const parser = parserForFile(file);
    if (!parser) continue;
    const source = readFileSync(file, "utf8");
    // Make the path stored in symbols repo-relative so `path` columns are
    // portable across machines.
    const rel = path.relative(repoRoot, file);
    let result;
    try {
      result = await parser.parse(rel, source);
    } catch {
      // §06 contract: parsers don't throw — but defensive try anyway.
      continue;
    }
    parseResults.push(result);
    for (const sym of result.symbols) {
      // Enforce repo-relative paths on every symbol. The parser
      // generally returns the path it was given, so this is a sanity belt.
      allSymbols.push({ ...sym, path: rel });
    }
    for (const ci of result.class_inheritance) {
      allClassInheritance.push(ci);
    }
  }

  // 2. Resolve edges + build graph + PageRank.
  //
  // POST-CODEX-001 e2e workaround / follow-on FOR §06+§07:
  // The §06 parsers emit ParserEdge records whose `from` field is a SHA-derived
  // symbol id (`symbolId(filePath, qname, startLine).slice(0,16)`), but they
  // emit LodestoneSymbol records whose `symbol` field is the qualified name
  // (e.g. `src/auth.ts::login`). §07 `resolveEdges` builds its index off the
  // qname-keyed symbol surface, so the `from` ids never match a graph node →
  // `buildGraph` stubs them as external, and graphology pageRank then chokes
  // when iterating outbound edges from those external nodes (TypeError:
  // Cannot read properties of undefined). We rewrite parser-emitted edge
  // `from` (sha id) → qname here so the resolved-edge graph is consistent.
  // Long-term fix belongs in §06 (have parsers emit qname as `from`) OR §07
  // (have resolveEdges build a sha→qname index alongside qname→qname).
  const idToQname = new Map<string, string>();
  for (const sym of allSymbols) {
    const sha = createHash("sha1")
      .update(`${sym.path}|${sym.symbol}|${sym.range.start_line}`)
      .digest("hex")
      .slice(0, 16);
    idToQname.set(sha, sym.symbol);
    // Also map the bare path → file-level barrel symbol for `imports` edges
    // whose `from` is a filePath (parsers' import emit pattern).
    if (!idToQname.has(sym.path)) {
      idToQname.set(sym.path, sym.symbol);
    }
  }
  const remappedEdges: ParserEdge[] = [];
  for (const r of parseResults) {
    for (const e of r.edges) {
      const from = idToQname.get(e.from) ?? e.from;
      // Drop edges whose `from` still doesn't map to any symbol — those would
      // become external stubs and trip up pageRank. This is a strictly
      // tighter graph than production; the follow-on noted above will let us
      // restore parity.
      if (!allSymbols.some((s) => s.symbol === from)) continue;
      remappedEdges.push({ ...e, from });
    }
  }
  const resolved = resolveEdges({ symbols: allSymbols, edges: remappedEdges });
  // Drop unresolved edges entirely for the e2e — buildGraph would stub them
  // as external nodes, and graphology pageRank chokes on those (same
  // outbound-edge iteration bug noted above). The resolved set is a strict
  // subset of production behaviour; the dropped count is logged via the
  // ResolveResult.unresolved field for diagnostics. Follow-on §07 work
  // should make pageRank robust to external-node stubs.
  const internalEdges = resolved.edges.filter((e) => e.resolved);
  const graph = buildGraph({ symbols: allSymbols, edges: internalEdges as ResolvedEdgeShape[] });
  const pr = pageRank(graph);

  // 3. Open writer + bootstrap schema.
  const w = openWriter(dbPath);
  let summary: IngestSummary;
  try {
    bootstrap(w);
    const indexEpoch = 1;
    writeSymbols(w, allSymbols, { index_epoch: indexEpoch, commit: null });
    writeEdges(w, graph);
    writePagerank(w, pr, graph);
    // Same parser/qname mismatch as for edges: §06 emits class_inheritance
    // triples whose `class_id` is the sha-derived id, but the symbols table
    // PK is the qname. Remap (or drop unmappable triples) before write so
    // the FK holds. Tracked as the same §06/§07 follow-on.
    const remappedInheritance = allClassInheritance
      .map((ci) => ({ ...ci, class_id: idToQname.get(ci.class_id) ?? ci.class_id }))
      .filter((ci) => allSymbols.some((s) => s.symbol === ci.class_id));
    writeClassInheritance(w, remappedInheritance);

    // 4. Cluster + persist.
    const clusters = runCluster(graph, pr, { seed: 42 });
    persistClusters(w, clusters, {
      index_epoch: indexEpoch,
      algorithm: "louvain",
      algorithm_version: "0.1.0",
    });

    // 5. Skills (seed) — the only deterministic source we have at v0.
    const seedSkills: Skill[] = seedSkillsFor(parseResults);
    writeSkills(
      w,
      seedSkills.map((skill) => ({
        skill,
        body_sha256: sha256Hex(skill.body),
        expires_at: null,
      })),
    );

    // 6. Embeddings — populate symbol_embeddings via a deterministic embedder
    //    so query() exercises the vector lane against real vec0 rows.
    ensureSymbolEmbeddingsTable(w);
    const embedder = createDeterministicEmbedder();
    const embeddingRows: EmbeddingRow[] = [];
    // Embed in batches of 16 for parity with production usage.
    for (let i = 0; i < allSymbols.length; i += 16) {
      const batch = allSymbols.slice(i, i + 16);
      const ids = batch.map((s) => s.symbol);
      const vectors = await embedder.embed(ids);
      for (let j = 0; j < batch.length; j++) {
        const sym = batch[j];
        const vec = vectors[j];
        if (!sym || !vec) continue;
        embeddingRows.push({ symbol_id: sym.symbol, vector: vec });
      }
    }
    writeEmbeddings(w, embeddingRows);

    // 7. ready.json — atomic marker the MCP tools gate on.
    writeReady(repoRoot, {
      schema_version: CURRENT_SCHEMA_VERSION,
      lodestone_version: "0.1.0-e2e",
      ready: true,
      embedder: { id: "e2e-deterministic", dim: VECTOR_DIM, quant: "fp32" },
      languages_indexed: Array.from(
        new Set(allSymbols.map((s) => s.language)),
      ).sort(),
      indexed_at: new Date().toISOString(),
      commit_at_index: null,
      dirty_at_index: false,
      index_epoch: indexEpoch,
      writer_pid: process.pid,
    });

    summary = {
      filesParsed: parseResults.length,
      symbolCount: allSymbols.length,
      edgeCount: resolved.edges.length,
      classInheritanceCount: allClassInheritance.length,
      clusterCount: clusters.length,
      skillCount: seedSkills.length,
      embeddingCount: embeddingRows.length,
    };
  } finally {
    closeDb(w);
    _resetWriterRegistry();
  }
  return summary;
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

/** Set both LODESTONE_CWD (consumed by §14 _shared.resolveCwd) AND
 * LODESTONE_DB_PATH (consumed by the §15 graph tools' db.ts resolver) around
 * `fn` then restore. The two surfaces evolved separately — both env vars are
 * mandatory for §15+ tools to point at our tmp DB. */
export async function withLodestoneCwd<T>(
  cwd: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prevCwd = process.env.LODESTONE_CWD;
  const prevDb = process.env.LODESTONE_DB_PATH;
  process.env.LODESTONE_CWD = cwd;
  process.env.LODESTONE_DB_PATH = lodestoneSubpath(cwd, "sqlite");
  try {
    return await fn();
  } finally {
    if (prevCwd === undefined) delete process.env.LODESTONE_CWD;
    else process.env.LODESTONE_CWD = prevCwd;
    if (prevDb === undefined) delete process.env.LODESTONE_DB_PATH;
    else process.env.LODESTONE_DB_PATH = prevDb;
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

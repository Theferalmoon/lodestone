// SPDX-License-Identifier: Apache-2.0
// End-to-end ingest pipeline driver. Walks a repo, parses every supported
// source file, resolves edges, builds the graph, computes PageRank, persists
// to SQLite, runs Louvain clustering, embeds every symbol, seeds skills, and
// writes the atomic `ready.json` marker.
//
// Used by:
//   - `lodestone init` / `lodestone reindex` (production — real nomic embedder)
//   - `e2e/run-e2e.ts` (deterministic embedder injected for hermetic tests)
//
// Compliance: NIST 800-53 SI-7 (Software & Information Integrity — atomic
// readiness marker), AU-2 (Audit Events — file/symbol counts surfaced for the
// caller to log), CM-6 (Configuration Settings — embedder identity captured
// in ready.json); CMMC L2 SI.L2-3.14.1; SOC 2 CC7.2; ISO 27001 A.12.1.2;
// FedRAMP Mod SI-7; CIS v8 Control 4.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import {
  CURRENT_SCHEMA_VERSION,
  lodestoneSubpath,
  type Edge as ResolvedEdgeShape,
  type LodestoneSymbol,
  type Skill,
} from "@lodestone/shared";

import { cluster as runCluster, persistClusters } from "../clusterer/index.js";
import type { EmbedderHandle } from "../embed/runtime.js";
import { buildGraph, pageRank, resolveEdges } from "../graph/index.js";
import { parserForFile } from "../parsers/index.js";
import type { ParseResult, ParserEdge } from "../parsers/base.js";
import { seedSkillsFor } from "../seed-skills/index.js";
import {
  emitClusterSkills,
  emitSeedSkillFiles,
  sha256Hex,
  writeSkills,
} from "../skill-emitter/index.js";
import {
  beginReindex,
  bootstrap,
  closeDb,
  ensureSymbolEmbeddingsTable,
  openWriter,
  VECTOR_DIM,
  writeClassInheritance,
  writeEdges,
  writeEmbeddings,
  writePagerank,
  writeReady,
  writeSymbols,
  type EmbeddingRow,
} from "../store/index.js";

// ── Types ─────────────────────────────────────────────────────────────────

export interface RunPipelineOptions {
  /** Repository root to walk. */
  repoRoot: string;
  /** Embedder handle. Caller owns lifecycle (create + close). */
  embedder: EmbedderHandle;
  /** Optional progress callback — receives short stage labels. */
  onProgress?: (stage: string) => void;
  /**
   * Embedder identity for the readiness marker. Required because the runtime
   * `EmbedderHandle` shape doesn't carry `quant`. The CLI passes the loader's
   * resolved identity here; the e2e harness passes its deterministic stub.
   */
  embedderIdentity: { id: string; dim: number; quant: string };
  /** Index epoch — bumped each reindex. Defaults to 1. */
  indexEpoch?: number;
}

export interface PipelineSummary {
  filesParsed: number;
  symbolCount: number;
  edgeCount: number;
  classInheritanceCount: number;
  clusterCount: number;
  skillCount: number;
  embeddingCount: number;
  unresolvedEdgeNames: number;
  droppedEdgeCount: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Recursive walk returning every file matched by a parser. Skips
 * `node_modules`, `.lodestone`, and `.git` by name. Symlinks are not
 * followed (keeps friendly behaviour on bind-mounted source trees).
 */
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
      if (entry.isSymbolicLink()) continue;
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

// ── Driver ────────────────────────────────────────────────────────────────

/**
 * Drive the full §05–§11 pipeline against `repoRoot`. Populates
 * `<repoRoot>/.lodestone/lodestone.sqlite` and writes ready.json. Caller is
 * responsible for opening + closing the embedder handle.
 *
 * Edge handling (POST-§20 Issue A):
 *   - §06 parsers emit `ParserEdge.from = qname` (matches `LodestoneSymbol.symbol`).
 *   - File-level imports edges (`from = filePath`) have no source-symbol; we
 *     drop them at graph-build time so PageRank sees a clean internal graph.
 *     `imports_from`/`imported_by` for §15 context tool come from per-symbol
 *     resolved imports edges that DO have a real source.
 */
export async function runPipeline(opts: RunPipelineOptions): Promise<PipelineSummary> {
  const { repoRoot, embedder, onProgress } = opts;
  const dbPath = lodestoneSubpath(repoRoot, "sqlite");
  const progress = onProgress ?? ((): void => {});

  // 1. Parse every supported file.
  progress("walk");
  const files = listSourceFiles(repoRoot);
  progress(`parse:${files.length}`);

  const parseResults: ParseResult[] = [];
  const allSymbols: LodestoneSymbol[] = [];
  const allClassInheritance: { class_id: string; base_name: string; base_path?: string }[] = [];
  const allEdges: ParserEdge[] = [];

  for (const file of files) {
    const parser = parserForFile(file);
    if (!parser) continue;
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    // Skip very large files — tree-sitter can chew them but the wall-time
    // cost is rarely worth it for v0. 5 MB ceiling per file.
    try {
      if (statSync(file).size > 5 * 1024 * 1024) continue;
    } catch {
      /* stat failure → just try the parse */
    }

    const rel = path.relative(repoRoot, file);
    let result: ParseResult;
    try {
      result = await parser.parse(rel, source);
    } catch {
      // §06 contract: parsers don't throw — but defensive try anyway.
      continue;
    }
    parseResults.push(result);
    for (const sym of result.symbols) {
      // Sanity belt: ensure `path` is repo-relative regardless of what the
      // parser stored. Symbols with absolute paths break pagerank node-key
      // identity across reindex runs.
      allSymbols.push({ ...sym, path: rel });
    }
    for (const ci of result.class_inheritance) {
      allClassInheritance.push(ci);
    }
    for (const e of result.edges) allEdges.push(e);
  }

  // 2. Resolve edges + build graph + PageRank.
  progress("resolve");
  // Drop edges whose `from` doesn't map to a known symbol — these are file-
  // level imports edges (parsers emit them with `from = filePath`). They have
  // no source-symbol attribution; carrying them through would only create
  // external stub source nodes that confuse PageRank (POST-§20 Issue A).
  const knownSymbolIds = new Set(allSymbols.map((s) => s.symbol));
  const internalParserEdges: ParserEdge[] = [];
  let droppedEdgeCount = 0;
  for (const e of allEdges) {
    if (!knownSymbolIds.has(e.from)) {
      droppedEdgeCount++;
      continue;
    }
    internalParserEdges.push(e);
  }
  const resolved = resolveEdges({ symbols: allSymbols, edges: internalParserEdges });
  // Keep only resolved edges in the graph; unresolved targets remain stub
  // external nodes which is fine for graph + PageRank, but downstream §15
  // queries only surface resolved-id edges anyway.
  const internalEdges = resolved.edges.filter((e) => e.resolved);
  const graph = buildGraph({ symbols: allSymbols, edges: internalEdges as ResolvedEdgeShape[] });
  progress("pagerank");
  const pr = pageRank(graph);

  // 3. Open writer + bootstrap schema + persist.
  progress("persist");
  const w = openWriter(dbPath);
  let summary: PipelineSummary;
  try {
    bootstrap(w);
    // impl-008 RED #1/#2/#3 fix: allocate a fresh monotonic epoch, wipe
    // every prior-pass row in one transaction, and stamp the embedder
    // identity so writeEmbeddings can validate vector dim. Whatever the
    // caller passed in `opts.indexEpoch` is honored as a *minimum* — if
    // a previous pass committed a higher epoch, beginReindex bumps past it.
    const allocatedEpoch = beginReindex(w, opts.embedderIdentity);
    const indexEpoch =
      opts.indexEpoch !== undefined && opts.indexEpoch > allocatedEpoch
        ? opts.indexEpoch
        : allocatedEpoch;
    writeSymbols(w, allSymbols, { index_epoch: indexEpoch, commit: null });
    writeEdges(w, graph);
    writePagerank(w, pr, graph);
    // class_inheritance triples: parsers now emit `class_id = qname` directly
    // (POST-§20 Issue A), so the FK to `symbols.id` holds without remap.
    // We still defensively filter to triples whose class_id we actually saw
    // in the symbol set — protects against parser bugs from regressing the FK.
    const internalInheritance = allClassInheritance.filter((ci) =>
      knownSymbolIds.has(ci.class_id),
    );
    writeClassInheritance(w, internalInheritance);

    // 4. Cluster + persist. Pass the embedder so cluster.description gets
    //    embedded into clusters.description_embedding (BLOB) — §16
    //    `cluster()`'s semantic-fallback lane reads this column.
    progress("cluster");
    const clusters = runCluster(graph, pr, { seed: 42 });
    await persistClusters(w, clusters, {
      index_epoch: indexEpoch,
      algorithm: "louvain",
      algorithm_version: "0.1.0",
      embedder,
    });

    // 5. Skills (seed) — deterministic v0 source. Embedder backfills
    //    skills.description_embedding so §16 `skills_for` cosine search
    //    has data to match against (otherwise it falls back to substring).
    progress("skills");
    const seedSkills: Skill[] = seedSkillsFor(parseResults);
    await writeSkills(
      w,
      seedSkills.map((skill) => ({
        skill,
        body_sha256: sha256Hex(skill.body),
        expires_at: null,
      })),
      { embedder },
    );

    // Codex v0.1.1 §10/§11 YELLOW: also emit on-disk SKILL.md cards so
    // friends can read + git-track the skill set. Cluster cards go to
    // .lodestone/skills/{emerging,observed}/ via the §10 emitter (with
    // selection gating + SQLite mirror); seed cards go to
    // .lodestone/skills/seed/ via the matching §11 helper. Both use SHA-
    // based idempotency so reruns do not churn disk.
    const lodestoneDir = path.dirname(dbPath);
    try {
      await emitClusterSkills(clusters, {
        lodestoneDir,
        db: w,
      });
    } catch (err) {
      // Disk emission is best-effort — never block pipeline completion on
      // a SKILL.md write failure (the SQLite mirror is the source of truth).
      progress(`skills_emit_warn:${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      await emitSeedSkillFiles(seedSkills, lodestoneDir);
    } catch (err) {
      progress(`seed_emit_warn:${err instanceof Error ? err.message : String(err)}`);
    }

    // 6. Embeddings — populate symbol_embeddings via the caller's embedder.
    progress(`embed:${allSymbols.length}`);
    ensureSymbolEmbeddingsTable(w);
    const embeddingRows: EmbeddingRow[] = [];
    const BATCH = 16;
    for (let i = 0; i < allSymbols.length; i += BATCH) {
      const batch = allSymbols.slice(i, i + BATCH);
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
    progress("ready");
    const identity = opts.embedderIdentity;
    writeReady(repoRoot, {
      schema_version: CURRENT_SCHEMA_VERSION,
      lodestone_version: "0.1.0",
      ready: true,
      embedder: identity,
      languages_indexed: Array.from(new Set(allSymbols.map((s) => s.language))).sort(),
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
      classInheritanceCount: internalInheritance.length,
      clusterCount: clusters.length,
      skillCount: seedSkills.length,
      embeddingCount: embeddingRows.length,
      unresolvedEdgeNames: resolved.unresolved.length,
      droppedEdgeCount,
    };
  } finally {
    closeDb(w);
  }
  return summary;
}

export type { EmbedderHandle } from "../embed/runtime.js";

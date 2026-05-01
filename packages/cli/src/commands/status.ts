// SPDX-License-Identifier: Apache-2.0
// `lodestone status` — IMPLEMENTED here. Reads `.lodestone/ready.json` (the
// post-Codex-001 readiness marker; replaces the old `version.json` referenced
// in the original §03 spec body) and prints index coverage, last ingest,
// staleness, embedder identity. `--json` emits a single JSON line.
//
// Per §02 path resolver, the marker filename is keyed as `ready` →
// `.lodestone/ready.json`. The shape matches the ReadyMarker interface
// produced by §08's writeReady() (still to be implemented), so this command
// uses a structural type that only requires the fields it actually reads.

import { existsSync, readFileSync } from "node:fs";
import { canonicalLodestoneDir, lodestoneSubpath } from "@lodestone/shared";
import { VERSION } from "../version.js";
import { output } from "../ui/output.js";

interface StatusOptions {
  json: boolean;
}

interface StatusReport {
  lodestone_version: string;
  schema_version: number | null;
  ready: boolean | null;
  embedder: { id: string; dim: number; quant: string } | null;
  languages_indexed: string[];
  indexed_at: string | null;
  indexed_at_human: string | null;
  staleness_seconds: number | null;
  commit_at_index: string | null;
  dirty_at_index: boolean | null;
  index_epoch: number | null;
  coverage: number | null;
}

interface ReadyMarkerLike {
  schema_version?: number;
  ready?: boolean;
  embedder?: { id?: string; dim?: number; quant?: string };
  languages_indexed?: string[];
  indexed_at?: string;
  commit_at_index?: string | null;
  dirty_at_index?: boolean;
  index_epoch?: number;
}

function parseStatusArgv(argv: readonly string[]): StatusOptions {
  return { json: argv.includes("--json") };
}

function humanizeAge(iso: string): string | null {
  const indexed = new Date(iso).getTime();
  if (Number.isNaN(indexed)) return null;
  const seconds = Math.max(0, Math.floor((Date.now() - indexed) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function buildReport(cwd: string, marker: ReadyMarkerLike): StatusReport {
  const indexed_at = marker.indexed_at ?? null;
  const staleness_seconds =
    indexed_at !== null
      ? Math.max(0, Math.floor((Date.now() - new Date(indexed_at).getTime()) / 1000))
      : null;

  // Coverage is written by later sections (§08 ingest produces it).
  // TODO(§08): pin the coverage.json schema in @lodestone/shared. Today we
  // only consume `coverage: number ∈ [0,1]`; if §08 adds more fields, we
  // should add a typed reader here.
  let coverage: number | null = null;
  try {
    const coveragePath = `${canonicalLodestoneDir(cwd)}/coverage.json`;
    if (existsSync(coveragePath)) {
      const parsed = JSON.parse(readFileSync(coveragePath, "utf8")) as { coverage?: number };
      if (typeof parsed.coverage === "number") coverage = parsed.coverage;
    }
  } catch {
    // ignore corrupt coverage file — surface as `unknown`
  }

  return {
    lodestone_version: VERSION,
    schema_version: marker.schema_version ?? null,
    ready: marker.ready ?? null,
    embedder:
      marker.embedder?.id && typeof marker.embedder.dim === "number" && marker.embedder.quant
        ? {
            id: marker.embedder.id,
            dim: marker.embedder.dim,
            quant: marker.embedder.quant,
          }
        : null,
    languages_indexed: marker.languages_indexed ?? [],
    indexed_at,
    indexed_at_human: indexed_at !== null ? humanizeAge(indexed_at) : null,
    staleness_seconds,
    commit_at_index: marker.commit_at_index ?? null,
    dirty_at_index: marker.dirty_at_index ?? null,
    index_epoch: marker.index_epoch ?? null,
    coverage,
  };
}

function printReport(report: StatusReport): void {
  const fmt = (label: string, value: string): string => `  ${label.padEnd(18)} ${value}`;
  output.info("lodestone status");
  output.info(fmt("lodestone version", report.lodestone_version));
  output.info(
    fmt(
      "schema version",
      report.schema_version === null ? "unknown" : String(report.schema_version)
    )
  );
  output.info(fmt("ready", report.ready === null ? "unknown" : String(report.ready)));
  output.info(
    fmt(
      "embedder",
      report.embedder
        ? `${report.embedder.id} (dim=${report.embedder.dim}, ${report.embedder.quant})`
        : "unknown"
    )
  );
  output.info(
    fmt(
      "languages",
      report.languages_indexed.length > 0 ? report.languages_indexed.join(", ") : "(none)"
    )
  );
  output.info(
    fmt(
      "indexed at",
      report.indexed_at && report.indexed_at_human
        ? `${report.indexed_at} (${report.indexed_at_human})`
        : "never"
    )
  );
  output.info(
    fmt(
      "staleness",
      report.staleness_seconds === null ? "unknown" : `${report.staleness_seconds}s`
    )
  );
  output.info(fmt("commit at index", report.commit_at_index ?? "unknown"));
  output.info(
    fmt(
      "dirty at index",
      report.dirty_at_index === null ? "unknown" : String(report.dirty_at_index)
    )
  );
  output.info(
    fmt("index epoch", report.index_epoch === null ? "unknown" : String(report.index_epoch))
  );
  output.info(
    fmt("coverage", report.coverage === null ? "unknown" : `${(report.coverage * 100).toFixed(0)}%`)
  );
}

export async function status(argv: readonly string[]): Promise<number> {
  const opts = parseStatusArgv(argv);
  const cwd = process.cwd();

  const lodestoneDir = canonicalLodestoneDir(cwd);
  if (!existsSync(lodestoneDir)) {
    output.error("No Lodestone index found in this directory. Run `lodestone init` first.");
    return 1;
  }

  const readyPath = lodestoneSubpath(cwd, "ready");
  if (!existsSync(readyPath)) {
    output.error("No `ready.json` marker found. Run `lodestone reindex` to rebuild the index.");
    return 1;
  }

  let marker: ReadyMarkerLike;
  try {
    marker = JSON.parse(readFileSync(readyPath, "utf8")) as ReadyMarkerLike;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    output.error(`Failed to read \`ready.json\`: ${detail}`);
    return 1;
  }

  const report = buildReport(cwd, marker);

  if (opts.json) {
    output.json(report);
  } else {
    printReport(report);
  }
  return 0;
}

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
import {
  canonicalLodestoneDir,
  lodestoneSubpath,
  parseReadyJson,
  type ReadyJson,
} from "@lodestone/shared";
import { VERSION } from "../version.js";
import { output } from "../ui/output.js";

interface StatusOptions {
  json: boolean;
}

interface StatusReport {
  lodestone_version: string;
  schema_version: number;
  ready: boolean;
  embedder: { id: string; dim: number; quant: string };
  languages_indexed: string[];
  indexed_at: string;
  indexed_at_human: string | null;
  staleness_seconds: number;
  commit_at_index: string | null;
  dirty_at_index: boolean;
  index_epoch: number;
  coverage: number | null;
  /**
   * Codex impl-003 B1: surface clock-skew when indexed_at is in the future
   * (negative staleness clamped to 0). Set when (Date.now() - indexed_at) is
   * more than 5 seconds negative.
   */
  clock_skew_detected: boolean;
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

function buildReport(cwd: string, marker: ReadyJson): StatusReport {
  const indexedMs = new Date(marker.indexed_at).getTime();
  const ageSeconds = Math.floor((Date.now() - indexedMs) / 1000);
  const staleness_seconds = Math.max(0, ageSeconds);
  // 5-second tolerance below zero so a couple of clock ticks don't trigger.
  const clock_skew_detected = ageSeconds < -5;

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
    schema_version: marker.schema_version,
    ready: marker.ready,
    embedder: marker.embedder,
    languages_indexed: marker.languages_indexed,
    indexed_at: marker.indexed_at,
    indexed_at_human: humanizeAge(marker.indexed_at),
    staleness_seconds,
    commit_at_index: marker.commit_at_index,
    dirty_at_index: marker.dirty_at_index,
    index_epoch: marker.index_epoch,
    coverage,
    clock_skew_detected,
  };
}

function printReport(report: StatusReport): void {
  const fmt = (label: string, value: string): string => `  ${label.padEnd(18)} ${value}`;
  output.info("lodestone status");
  output.info(fmt("lodestone version", report.lodestone_version));
  output.info(fmt("schema version", String(report.schema_version)));
  output.info(fmt("ready", String(report.ready)));
  output.info(
    fmt(
      "embedder",
      `${report.embedder.id} (dim=${report.embedder.dim}, ${report.embedder.quant})`
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
      report.indexed_at_human
        ? `${report.indexed_at} (${report.indexed_at_human})`
        : `${report.indexed_at} (invalid)`
    )
  );
  output.info(fmt("staleness", `${report.staleness_seconds}s`));
  output.info(fmt("commit at index", report.commit_at_index ?? "(non-git)"));
  output.info(fmt("dirty at index", String(report.dirty_at_index)));
  output.info(fmt("index epoch", String(report.index_epoch)));
  output.info(
    fmt("coverage", report.coverage === null ? "unknown" : `${(report.coverage * 100).toFixed(0)}%`)
  );
  if (report.clock_skew_detected) {
    output.warn(
      "indexed_at is in the future — clock skew detected; staleness clamped to 0."
    );
  }
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

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(readyPath, "utf8"));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    output.error(`Failed to read \`ready.json\`: ${detail}`);
    return 1;
  }

  // Codex impl-003 B1/D1: validate via the canonical shared schema BEFORE
  // building the report. This rejects wrong-typed fields up-front so we
  // never emit partial stdout followed by an "internal error".
  let marker: ReadyJson;
  try {
    marker = parseReadyJson(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    output.error(`Invalid \`ready.json\` shape: ${detail}`);
    return 1;
  }

  const report = buildReport(cwd, marker);

  if (opts.json) {
    output.json(report);
  } else {
    printReport(report);
  }
  // Codex impl-003 B1: ready=false ⇒ degraded; surface to scripts via exit 1.
  return marker.ready ? 0 : 1;
}

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
import { readRepoIdentity, lodestoneDirForRoot, type RepoIdentity } from "../git/repo-identity.js";
import { pathsEqual } from "../path-equal.js";
import { VERSION } from "../version.js";
import { output } from "../ui/output.js";
import { readInstallManifest } from "../uninstall/manifest-reader.js";

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
  install_manifest: InstallManifestStatus;
  repo_identity: RepoIdentity;
  index_consistency: IndexConsistencyStatus;
  /**
   * Codex impl-003 B1: surface clock-skew when indexed_at is in the future
   * (negative staleness clamped to 0). Set when (Date.now() - indexed_at) is
   * more than 5 seconds negative.
   */
  clock_skew_detected: boolean;
}

interface InstallManifestStatus {
  present: boolean;
  path: string;
  install_state: "pending" | "complete" | null;
  reindex_state: "complete" | "failed" | "skipped" | null;
  read_error: string | null;
}

interface IndexConsistencyStatus {
  indexed_commit: string | null;
  head_commit: string | null;
  git_head_matches_index: boolean | null;
  dirty_at_index: boolean;
  dirty_now: boolean | null;
  warnings: string[];
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

function readInstallManifestStatus(cwd: string): InstallManifestStatus {
  const result = readInstallManifest(cwd);
  if (result.ok) {
    return {
      present: true,
      path: result.path,
      install_state: result.manifest.install_state,
      reindex_state: result.manifest.reindex_state ?? null,
      read_error: null,
    };
  }
  return {
    present: false,
    path: result.path,
    install_state: null,
    reindex_state: null,
    read_error:
      result.reason === "missing"
        ? null
        : `${result.reason}${result.detail ? `: ${result.detail}` : ""}`,
  };
}

function buildIndexConsistency(
  marker: ReadyJson,
  repoIdentity: RepoIdentity
): IndexConsistencyStatus {
  const warnings: string[] = [];
  let gitHeadMatchesIndex: boolean | null = null;
  if (marker.commit_at_index !== null && repoIdentity.head_commit !== null) {
    gitHeadMatchesIndex = commitsMatch(marker.commit_at_index, repoIdentity.head_commit);
    if (!gitHeadMatchesIndex) {
      warnings.push(
        `Index was built at commit ${marker.commit_at_index}, but current HEAD is ${repoIdentity.head_commit}.`
      );
    }
  }
  if (marker.dirty_at_index) {
    warnings.push("Index was built from a dirty working tree.");
  }
  if (repoIdentity.dirty_now === true && marker.commit_at_index !== null) {
    warnings.push("Working tree has uncommitted changes; rerun `lodestone reindex` if results look stale.");
  }
  return {
    indexed_commit: marker.commit_at_index,
    head_commit: repoIdentity.head_commit,
    git_head_matches_index: gitHeadMatchesIndex,
    dirty_at_index: marker.dirty_at_index,
    dirty_now: repoIdentity.dirty_now,
    warnings,
  };
}

function buildReport(cwd: string, marker: ReadyJson, repoIdentity: RepoIdentity): StatusReport {
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
    install_manifest: readInstallManifestStatus(cwd),
    repo_identity: repoIdentity,
    index_consistency: buildIndexConsistency(marker, repoIdentity),
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
  output.info(fmt("cwd", report.repo_identity.cwd));
  output.info(fmt("git root", report.repo_identity.git_root ?? "(not a git repo)"));
  if (report.repo_identity.is_git_repo) {
    output.info(fmt("git branch", report.repo_identity.branch ?? "(detached)"));
    output.info(fmt("git head", report.repo_identity.head_commit ?? "(unknown)"));
    output.info(fmt("git dirty", formatNullableBoolean(report.repo_identity.dirty_now)));
    output.info(fmt("upstream", report.repo_identity.upstream_branch ?? "(none)"));
  }
  if (report.install_manifest.present) {
    output.info(fmt("install state", report.install_manifest.install_state ?? "unknown"));
    output.info(fmt("reindex state", report.install_manifest.reindex_state ?? "not recorded"));
  } else if (report.install_manifest.read_error !== null) {
    output.info(fmt("install manifest", report.install_manifest.read_error));
  }
  output.info(
    fmt("coverage", report.coverage === null ? "unknown" : `${(report.coverage * 100).toFixed(0)}%`)
  );
  if (report.clock_skew_detected) {
    output.warn(
      "indexed_at is in the future — clock skew detected; staleness clamped to 0."
    );
  }
  for (const warning of report.index_consistency.warnings) {
    output.warn(warning);
  }
}

export async function status(argv: readonly string[]): Promise<number> {
  const opts = parseStatusArgv(argv);
  const cwd = process.cwd();
  const repoIdentity = readRepoIdentity(cwd);

  const lodestoneDir = canonicalLodestoneDir(cwd);
  if (!existsSync(lodestoneDir)) {
    if (
      repoIdentity.git_root !== null &&
      !pathsEqual(cwd, repoIdentity.git_root) &&
      existsSync(lodestoneDirForRoot(repoIdentity.git_root))
    ) {
      output.error(
        `No Lodestone index found in this directory. A Lodestone index exists at Git root ${repoIdentity.git_root}.`
      );
      output.error("Run `lodestone status` from the Git root, or run `lodestone init` here for an intentional subproject.");
    } else {
      output.error("No Lodestone index found in this directory. Run `lodestone init` first.");
    }
    return 1;
  }

  const readyPath = lodestoneSubpath(cwd, "ready");
  if (!existsSync(readyPath)) {
    output.error("No `ready.json` marker found. Run `lodestone reindex` to rebuild the index.");
    const manifest = readInstallManifestStatus(cwd);
    if (manifest.present) {
      output.error(
        `Install manifest reports install_state=${manifest.install_state ?? "unknown"}, ` +
          `reindex_state=${manifest.reindex_state ?? "not recorded"}.`
      );
      if (manifest.reindex_state === "failed") {
        output.error("The last install-side reindex failed; rerun `lodestone reindex` after fixing the reported cause.");
      }
    } else if (manifest.read_error !== null) {
      output.error(`Install manifest unreadable: ${manifest.read_error}`);
    }
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

  const report = buildReport(cwd, marker, repoIdentity);

  if (opts.json) {
    output.json(report);
  } else {
    printReport(report);
  }
  // Codex impl-003 B1: ready=false ⇒ degraded; surface to scripts via exit 1.
  return marker.ready ? 0 : 1;
}

function commitsMatch(indexed: string, head: string): boolean {
  if (indexed.length < 7 || head.length < 7) return false;
  return indexed === head || indexed.startsWith(head) || head.startsWith(indexed);
}

function formatNullableBoolean(value: boolean | null): string {
  return value === null ? "(unknown)" : String(value);
}

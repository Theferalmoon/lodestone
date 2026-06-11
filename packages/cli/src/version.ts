// SPDX-License-Identifier: Apache-2.0
// Exports VERSION + COMMIT_HASH used by `lodestone --version` and the
// MCP envelope's lodestone_version field. VERSION is read from this
// package's own package.json (not the workspace root). COMMIT_HASH is
// best-effort: runtime injection if available, else source-checkout
// `git rev-parse`, else a packaged build-info.json written during release
// packing, else "dev".
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function readVersion(): string {
  // Walk upward from the compiled file location until we find OUR package.json.
  // In dist/, that's two levels up; in src/ tests it's one level up. Tolerate both.
  for (const candidate of [
    path.join(HERE, "..", "package.json"),
    path.join(HERE, "..", "..", "package.json"),
  ]) {
    try {
      const raw = readFileSync(candidate, "utf8");
      const pkg = JSON.parse(raw) as { name?: string; version?: string };
      if (pkg.name === "@lodestone/cli" && typeof pkg.version === "string") {
        return pkg.version;
      }
    } catch {
      // try next candidate
    }
  }
  return "0.0.0-unknown";
}

function readGitCommitHash(cwd: string): string | null {
  try {
    const hash = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    if (hash.length > 0) return hash;
  } catch {
    // git unavailable or not a repo
  }
  return null;
}

function readPackagedBuildInfoCommit(here: string): string | null {
  try {
    const raw = readFileSync(path.join(here, "build-info.json"), "utf8");
    const info = JSON.parse(raw) as {
      commit_hash?: unknown;
      commit?: unknown;
    };
    const value = typeof info.commit_hash === "string" ? info.commit_hash : info.commit;
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  } catch {
    // release build metadata is optional in source checkouts
  }
  return null;
}

function isInsideNodeModules(here: string): boolean {
  let current = path.resolve(here);
  while (current !== path.dirname(current)) {
    if (path.basename(current) === "node_modules") return true;
    current = path.dirname(current);
  }
  return path.basename(current) === "node_modules";
}

export interface CommitHashLookupOptions {
  here?: string;
  env?: Record<string, string | undefined>;
  readGitCommitHash?: (cwd: string) => string | null;
  readPackagedBuildInfoCommit?: (here: string) => string | null;
}

export function resolveCommitHash(options: CommitHashLookupOptions = {}): string {
  const here = options.here ?? HERE;
  const env = options.env ?? process.env;

  const injected = env.LODESTONE_COMMIT_HASH;
  if (injected && injected.length > 0) return injected;

  if (!isInsideNodeModules(here)) {
    const gitHash = (options.readGitCommitHash ?? readGitCommitHash)(here);
    if (gitHash !== null && gitHash.length > 0) return gitHash;
  }

  const packagedHash = (options.readPackagedBuildInfoCommit ?? readPackagedBuildInfoCommit)(here);
  if (packagedHash !== null && packagedHash.length > 0) return packagedHash;

  return "dev";
}

export const VERSION: string = readVersion();
export const COMMIT_HASH: string = resolveCommitHash();

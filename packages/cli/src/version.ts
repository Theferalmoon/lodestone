// SPDX-License-Identifier: Apache-2.0
// Exports VERSION + COMMIT_HASH used by `lodestone --version` and the
// MCP envelope's lodestone_version field. VERSION is read from this
// package's own package.json (not the workspace root). COMMIT_HASH is
// best-effort: build-time injection if available, else `git rev-parse`,
// else "dev".
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

function readCommitHash(): string {
  // Build-time injection wins when present.
  const injected = process.env.LODESTONE_COMMIT_HASH;
  if (injected && injected.length > 0) return injected;

  // Best-effort git lookup; quiet on failure.
  try {
    const hash = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: HERE,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    if (hash.length > 0) return hash;
  } catch {
    // git unavailable or not a repo
  }
  return "dev";
}

export const VERSION: string = readVersion();
export const COMMIT_HASH: string = readCommitHash();

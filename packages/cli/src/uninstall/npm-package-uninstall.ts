// SPDX-License-Identifier: Apache-2.0
// Removes Lodestone's project-local npm install footprint. The public friend
// installer uses `npm install --no-save` into the target repo, so a clean
// uninstall must ask npm to remove the Lodestone packages and prune their
// transient dependency tree instead of deleting only `node_modules/@lodestone`.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readdirSync,
  rmSync,
  rmdirSync,
} from "node:fs";
import path from "node:path";

export const LODESTONE_NPM_PACKAGES = [
  "@lodestone/cli",
  "@lodestone/ingest",
  "@lodestone/mcp-server",
  "@lodestone/shared",
] as const;

export interface RemoveLodestoneNpmPackagesResult {
  /**
   * - `removed`: Lodestone npm packages were present and npm removed them.
   * - `noop`: no project-local Lodestone npm packages were detected.
   * - `failed`: npm failed, or Lodestone packages were still present after npm.
   */
  action: "removed" | "noop" | "failed";
  path: string;
  packages: string[];
  bytesFreed: number;
  detail?: string;
}

type NpmRunner = (
  file: string,
  args: string[],
  options: {
    cwd: string;
    encoding: "utf8";
    stdio: ["ignore", "pipe", "pipe"];
  }
) => unknown;

export function removeLodestoneNpmPackages(
  repoRoot: string,
  opts: { dryRun?: boolean; runNpm?: NpmRunner } = {}
): RemoveLodestoneNpmPackagesResult {
  const nodeModulesPath = path.join(repoRoot, "node_modules");
  const installed = findInstalledLodestonePackages(nodeModulesPath);
  if (installed.length === 0) {
    return {
      action: "noop",
      path: nodeModulesPath,
      packages: [],
      bytesFreed: 0,
    };
  }

  if (opts.dryRun === true) {
    return {
      action: "removed",
      path: nodeModulesPath,
      packages: installed,
      bytesFreed: computePackageBytes(nodeModulesPath, installed),
    };
  }

  const beforeBytes = existsSync(nodeModulesPath)
    ? computeTreeSize(nodeModulesPath)
    : 0;
  const runNpm = opts.runNpm ?? execFileSync;
  try {
    runNpm(
      "npm",
      [
        "uninstall",
        "--no-save",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        ...installed,
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
  } catch (err) {
    return {
      action: "failed",
      path: nodeModulesPath,
      packages: installed,
      bytesFreed: 0,
      detail: npmErrorDetail(err),
    };
  }

  pruneNodeModulesScaffolding(nodeModulesPath);

  const remaining = findInstalledLodestonePackages(nodeModulesPath);
  if (remaining.length > 0) {
    return {
      action: "failed",
      path: nodeModulesPath,
      packages: installed,
      bytesFreed: 0,
      detail: `npm completed but Lodestone packages remain: ${remaining.join(", ")}`,
    };
  }

  const afterBytes = existsSync(nodeModulesPath)
    ? computeTreeSize(nodeModulesPath)
    : 0;
  return {
    action: "removed",
    path: nodeModulesPath,
    packages: installed,
    bytesFreed: Math.max(0, beforeBytes - afterBytes),
  };
}

function findInstalledLodestonePackages(nodeModulesPath: string): string[] {
  return LODESTONE_NPM_PACKAGES.filter((pkg) =>
    existsSync(packagePath(nodeModulesPath, pkg))
  );
}

function packagePath(nodeModulesPath: string, packageName: string): string {
  const parts = packageName.split("/");
  const scope = parts[0];
  if (scope === undefined || scope.length === 0) return nodeModulesPath;
  const name = parts[1];
  return name === undefined
    ? path.join(nodeModulesPath, scope)
    : path.join(nodeModulesPath, scope, name);
}

function computePackageBytes(
  nodeModulesPath: string,
  packageNames: readonly string[]
): number {
  return packageNames.reduce(
    (total, pkg) => total + computeTreeSize(packagePath(nodeModulesPath, pkg)),
    0
  );
}

function pruneNodeModulesScaffolding(nodeModulesPath: string): void {
  if (!existsSync(nodeModulesPath)) return;
  pruneEmptyDirectories(nodeModulesPath);

  removeNpmMetadataOnlyTree(nodeModulesPath);

  pruneEmptyDirectories(nodeModulesPath);
}

function removeNpmMetadataOnlyTree(nodeModulesPath: string): void {
  const entries = readDirectoryEntries(nodeModulesPath);
  if (entries === null) return;

  if (entries.length === 1 && entries[0] === ".package-lock.json") {
    rmSync(path.join(nodeModulesPath, ".package-lock.json"), { force: true });
  }
}

function readDirectoryEntries(dir: string): string[] | null {
  try {
    return readdirSync(dir);
  } catch {
    return null;
  }
}

function pruneEmptyDirectories(dir: string): void {
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    return;
  }
  if (!st.isDirectory() || st.isSymbolicLink()) return;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const child = path.join(dir, entry);
    let childStat;
    try {
      childStat = lstatSync(child);
    } catch {
      continue;
    }
    if (childStat.isDirectory() && !childStat.isSymbolicLink()) {
      pruneEmptyDirectories(child);
    }
  }

  try {
    if (readdirSync(dir).length === 0) {
      rmdirSync(dir);
    }
  } catch {
    // Best-effort cleanup only. npm already removed the package payload.
  }
}

function computeTreeSize(target: string): number {
  if (!existsSync(target)) return 0;
  let total = 0;
  const stack: string[] = [target];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    let st;
    try {
      st = lstatSync(current);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      total += st.size;
      continue;
    }
    if (st.isDirectory()) {
      let entries: string[];
      try {
        entries = readdirSync(current);
      } catch {
        continue;
      }
      for (const entry of entries) {
        stack.push(path.join(current, entry));
      }
      continue;
    }
    if (st.isFile()) {
      total += st.size;
    }
  }
  return total;
}

function npmErrorDetail(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const maybe = err as { stderr?: unknown; stdout?: unknown; message?: unknown };
    const stderr = bufferLikeToString(maybe.stderr);
    if (stderr.length > 0) return stderr;
    const stdout = bufferLikeToString(maybe.stdout);
    if (stdout.length > 0) return stdout;
    if (typeof maybe.message === "string") return maybe.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

function bufferLikeToString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Buffer.isBuffer(value)) return value.toString("utf8").trim();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8").trim();
  return "";
}

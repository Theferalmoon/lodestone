// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import path from "node:path";
import { LODESTONE_DIRNAME } from "@lodestone/shared";
import { pathsEqual } from "../path-equal.js";

export interface RepoIdentity {
  cwd: string;
  is_git_repo: boolean;
  git_root: string | null;
  cwd_is_git_root: boolean | null;
  branch: string | null;
  head_commit: string | null;
  upstream_branch: string | null;
  commits_behind_upstream: number | null;
  dirty_now: boolean | null;
  lodestone_dir: string;
  ready_path: string;
  mcp_json_path: string;
  codex_config_path: string;
}

type GitRunner = (cwd: string, args: readonly string[]) => string | null;

export interface RepoIdentityDeps {
  runGit?: GitRunner;
}

export function readRepoIdentity(
  cwd: string = process.cwd(),
  deps: RepoIdentityDeps = {}
): RepoIdentity {
  const runGit = deps.runGit ?? defaultRunGit;
  const root = runGit(cwd, ["rev-parse", "--show-toplevel"]);
  const gitRoot = root === null || root === "" ? null : path.resolve(root);
  const gitCwd = gitRoot ?? cwd;
  const branch = gitRoot === null ? null : emptyToNull(runGit(gitCwd, ["branch", "--show-current"]));
  const headCommit = gitRoot === null ? null : emptyToNull(runGit(gitCwd, ["rev-parse", "--short", "HEAD"]));
  const upstream =
    gitRoot === null
      ? null
      : emptyToNull(runGit(gitCwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]));
  const behindRaw = upstream === null ? null : runGit(gitCwd, ["rev-list", "--count", "HEAD..@{u}"]);
  const dirtyRaw = gitRoot === null ? null : runGit(gitCwd, ["status", "--porcelain"]);

  return {
    cwd,
    is_git_repo: gitRoot !== null,
    git_root: gitRoot,
    cwd_is_git_root: gitRoot === null ? null : pathsEqual(cwd, gitRoot),
    branch,
    head_commit: headCommit,
    upstream_branch: upstream,
    commits_behind_upstream: parseNonNegativeInt(behindRaw),
    dirty_now: dirtyRaw === null ? null : dirtyRaw.length > 0,
    lodestone_dir: path.join(cwd, LODESTONE_DIRNAME),
    ready_path: path.join(cwd, LODESTONE_DIRNAME, "ready.json"),
    mcp_json_path: path.join(cwd, ".mcp.json"),
    codex_config_path: path.join(cwd, ".codex", "config.toml"),
  };
}

export function lodestoneDirForRoot(root: string): string {
  return path.join(root, LODESTONE_DIRNAME);
}

function defaultRunGit(cwd: string, args: readonly string[]): string | null {
  try {
    return execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function emptyToNull(value: string | null): string | null {
  if (value === null || value === "") return null;
  return value;
}

function parseNonNegativeInt(value: string | null): number | null {
  if (value === null || value === "") return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  LODESTONE_NPM_PACKAGES,
  removeLodestoneNpmPackages,
} from "./npm-package-uninstall.js";

describe("removeLodestoneNpmPackages", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "lodestone-npm-uninst-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeFixtureFile(relativePath: string, body = "x"): void {
    const target = path.join(tmp, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, body);
  }

  function createLodestonePackage(packageName: string): void {
    const packagePath = path.join(tmp, "node_modules", ...packageName.split("/"));
    mkdirSync(packagePath, { recursive: true });
    writeFileSync(path.join(packagePath, "package.json"), "{}\n");
  }

  it("returns noop when no project-local Lodestone packages are installed", () => {
    const r = removeLodestoneNpmPackages(tmp);
    expect(r).toEqual({
      action: "noop",
      path: path.join(tmp, "node_modules"),
      packages: [],
      bytesFreed: 0,
    });
  });

  it("dry-run plans package removal without running npm or touching disk", () => {
    createLodestonePackage("@lodestone/cli");
    writeFixtureFile("node_modules/left-alone/package.json", "{}\n");
    const runNpm = vi.fn();

    const r = removeLodestoneNpmPackages(tmp, { dryRun: true, runNpm });

    expect(r.action).toBe("removed");
    expect(r.packages).toEqual(["@lodestone/cli"]);
    expect(r.bytesFreed).toBeGreaterThan(0);
    expect(runNpm).not.toHaveBeenCalled();
    expect(existsSync(path.join(tmp, "node_modules", "@lodestone", "cli"))).toBe(true);
    expect(existsSync(path.join(tmp, "node_modules", "left-alone"))).toBe(true);
  });

  it("uses npm uninstall and prunes empty node_modules scaffolding", () => {
    for (const pkg of LODESTONE_NPM_PACKAGES) {
      createLodestonePackage(pkg);
    }
    writeFixtureFile("node_modules/onnxruntime-node/bin/blob", "large");
    writeFixtureFile("node_modules/.package-lock.json", "{}\n");
    mkdirSync(path.join(tmp, "node_modules", ".bin"), { recursive: true });
    mkdirSync(path.join(tmp, "node_modules", "@npmcli"), { recursive: true });

    const runNpm = vi.fn((_file: string, _args: string[]) => {
      rmSync(path.join(tmp, "node_modules", "@lodestone", "cli"), {
        recursive: true,
        force: true,
      });
      rmSync(path.join(tmp, "node_modules", "@lodestone", "ingest"), {
        recursive: true,
        force: true,
      });
      rmSync(path.join(tmp, "node_modules", "@lodestone", "mcp-server"), {
        recursive: true,
        force: true,
      });
      rmSync(path.join(tmp, "node_modules", "@lodestone", "shared"), {
        recursive: true,
        force: true,
      });
      rmSync(path.join(tmp, "node_modules", "onnxruntime-node"), {
        recursive: true,
        force: true,
      });
    });

    const r = removeLodestoneNpmPackages(tmp, { runNpm });

    expect(runNpm).toHaveBeenCalledWith(
      "npm",
      [
        "uninstall",
        "--no-save",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "@lodestone/cli",
        "@lodestone/ingest",
        "@lodestone/mcp-server",
        "@lodestone/shared",
      ],
      {
        cwd: tmp,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    expect(r.action).toBe("removed");
    expect(r.bytesFreed).toBeGreaterThan(0);
    expect(existsSync(path.join(tmp, "node_modules"))).toBe(false);
  });

  it("returns failed when npm errors and leaves packages intact", () => {
    createLodestonePackage("@lodestone/cli");
    const error = Object.assign(new Error("npm exited 1"), {
      stderr: Buffer.from("npm cleanup failed"),
    });

    const r = removeLodestoneNpmPackages(tmp, {
      runNpm: () => {
        throw error;
      },
    });

    expect(r.action).toBe("failed");
    expect(r.detail).toContain("npm cleanup failed");
    expect(existsSync(path.join(tmp, "node_modules", "@lodestone", "cli"))).toBe(true);
  });

  it("returns failed when npm exits successfully but Lodestone packages remain", () => {
    createLodestonePackage("@lodestone/cli");

    const r = removeLodestoneNpmPackages(tmp, {
      runNpm: () => undefined,
    });

    expect(r.action).toBe("failed");
    expect(r.detail).toContain("@lodestone/cli");
  });
});

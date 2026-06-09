#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Build a private Claude Desktop MCPB bundle for Lodestone.
//
// The bundle is current-platform by design because Lodestone's dependency tree
// includes native Node modules. Build separate MCPB artifacts on each target OS
// you intend to distribute.

import { execFileSync } from "node:child_process";
import {
  cpSync,
  readdirSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOT_PACKAGE = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
const VERSION = ROOT_PACKAGE.version;

function usage(exitCode = 64) {
  process.stderr.write(`usage: scripts/mcpb/build-claude-desktop-bundle.mjs [options]

Options:
  --profile <lite|full>    Embedder profile to package. Default: lite.
  --out-dir <dir>          Output directory. Default: dist/mcpb.
  --skip-build             Do not run pnpm -r build before packing.
  --skip-docs              Do not rebuild friend docs during tarball packing.
  --manifest-only          Build a structural MCPB smoke artifact without node_modules.
  --keep-staging           Keep temporary staging directory for inspection.
  -h, --help               Show this help.

Default output:
  dist/mcpb/lodestone-claude-desktop-${VERSION}-<profile>-${process.platform}.mcpb
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const opts = {
    profile: "lite",
    outDir: path.join(REPO_ROOT, "dist", "mcpb"),
    skipBuild: false,
    skipDocs: false,
    manifestOnly: false,
    keepStaging: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "-h" || token === "--help") usage(0);
    if (token === "--profile") {
      opts.profile = argv[++i] ?? "";
    } else if (token.startsWith("--profile=")) {
      opts.profile = token.slice("--profile=".length);
    } else if (token === "--out-dir") {
      opts.outDir = path.resolve(argv[++i] ?? "");
    } else if (token.startsWith("--out-dir=")) {
      opts.outDir = path.resolve(token.slice("--out-dir=".length));
    } else if (token === "--skip-build") {
      opts.skipBuild = true;
    } else if (token === "--skip-docs") {
      opts.skipDocs = true;
    } else if (token === "--manifest-only") {
      opts.manifestOnly = true;
    } else if (token === "--keep-staging") {
      opts.keepStaging = true;
    } else {
      fail(`unknown option: ${token}`);
    }
  }

  if (!["lite", "full"].includes(opts.profile)) {
    fail(`invalid --profile '${opts.profile}' (allowed: lite | full)`);
  }
  if (!opts.outDir) {
    fail("--out-dir requires a value");
  }
  return opts;
}

function log(message) {
  process.stderr.write(`[lodestone-mcpb] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`[lodestone-mcpb] ERROR: ${message}\n`);
  process.exit(1);
}

function run(command, args, options = {}) {
  log(`${command} ${args.join(" ")}`);
  execFileSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    env: options.env ?? process.env,
    stdio: "inherit",
  });
}

function makeManifest(profile) {
  return {
    $schema:
      "https://raw.githubusercontent.com/anthropics/mcpb/main/schemas/mcpb-manifest-v0.4.schema.json",
    manifest_version: "0.4",
    name: "cmndi-lodestone",
    display_name: "Lodestone",
    version: VERSION,
    description:
      "Local codebase knowledge graph MCP server for Claude Desktop. Runs against a repository where Lodestone has already been initialized.",
    long_description:
      "Lodestone packages a project-local code knowledge graph as MCP tools for query, context, impact analysis, clusters, recent changes, skill suggestions, and local feedback. This private MCPB bundle is current-platform only and does not send project code or telemetry to CMNDI.",
    author: {
      name: "Cybersecurity Management & Network Defense, Inc.",
      url: "https://cmndi.ai",
    },
    repository: {
      type: "git",
      url: "https://github.com/Theferalmoon/lodestone.git",
    },
    homepage: "https://lodestone.cmndi.ai",
    documentation: "https://lodestone.cmndi.ai/docs",
    support: "https://github.com/Theferalmoon/lodestone/issues",
    license: "Apache-2.0",
    keywords: [
      "mcp",
      "claude-desktop",
      "code-search",
      "knowledge-graph",
      "local-first",
      "privacy",
      profile,
    ],
    compatibility: {
      platforms: [process.platform],
      runtimes: {
        node: ">=20.0.0",
      },
    },
    server: {
      type: "node",
      entry_point: "server/lodestone-mcpb-launcher.js",
      mcp_config: {
        command: "node",
        args: ["${__dirname}/server/lodestone-mcpb-launcher.js"],
        env: {
          LODESTONE_REPO_ROOT: "${user_config.repository_root}",
        },
      },
    },
    user_config: {
      repository_root: {
        type: "directory",
        title: "Project folder",
        description:
          "Select the repository where Lodestone has already been installed and indexed.",
        required: true,
        default: "${HOME}",
      },
    },
    tools: [
      {
        name: "query",
        description: "Search the local Lodestone code index for matching symbols and snippets.",
      },
      {
        name: "context",
        description: "Gather local code context around a symbol, file, or task.",
      },
      {
        name: "impact",
        description: "Trace likely affected local files and symbols before a change.",
      },
      {
        name: "cluster",
        description: "Inspect local codebase clusters and subsystem groupings.",
      },
      {
        name: "skills_for",
        description: "Suggest local project skill cards relevant to a task.",
      },
      {
        name: "recent_changes",
        description: "Summarize recent local Git changes for the selected repository.",
      },
      {
        name: "feedback",
        description: "Record local feedback about Lodestone result quality.",
      },
    ],
    tools_generated: true,
  };
}

function validateManifest(manifest) {
  const required = ["manifest_version", "name", "version", "description", "author", "server"];
  for (const key of required) {
    if (manifest[key] === undefined) fail(`manifest missing required field: ${key}`);
  }
  if (manifest.manifest_version !== "0.4") {
    fail("manifest_version must be 0.4");
  }
  if (manifest.server.type !== "node") {
    fail("manifest server.type must be node");
  }
  if (manifest.server.entry_point !== "server/lodestone-mcpb-launcher.js") {
    fail("manifest server.entry_point drifted from launcher path");
  }
  if (!manifest.user_config?.repository_root) {
    fail("manifest must request repository_root user_config");
  }
}

function writeLauncher(bundleRoot) {
  const launcher = `#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Claude Desktop MCPB launcher for Lodestone.

import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function fail(message) {
  process.stderr.write(\`[lodestone-mcpb] \${message}\\n\`);
  process.exit(1);
}

try {
  const rawRoot = (process.env.LODESTONE_REPO_ROOT ?? "").trim();
  if (!rawRoot) {
    fail("LODESTONE_REPO_ROOT is required. Select a project folder in the extension settings.");
  }

  const repoRoot = path.resolve(rawRoot);
  try {
    if (!statSync(repoRoot).isDirectory()) {
      fail(\`Project folder is not a directory: \${repoRoot}\`);
    }
  } catch {
    fail(\`Project folder does not exist: \${repoRoot}\`);
  }

  const configPath = path.join(repoRoot, ".lodestone", "lodestone.toml");
  if (!existsSync(configPath)) {
    fail(
      \`Lodestone is not initialized in \${repoRoot}. Run lodestone init and lodestone reindex there first.\`,
    );
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const serverEntry = path.resolve(
    here,
    "..",
    "node_modules",
    "@lodestone",
    "mcp-server",
    "dist",
    "server.js",
  );
  if (!existsSync(serverEntry)) {
    fail(\`Bundled @lodestone/mcp-server entry is missing: \${serverEntry}\`);
  }

  process.chdir(repoRoot);
  const server = await import(pathToFileURL(serverEntry).href);
  if (typeof server.main !== "function") {
    fail("Bundled @lodestone/mcp-server does not export main().");
  }
  await server.main();
} catch (err) {
  const detail = err instanceof Error ? err.message : String(err);
  fail(\`fatal: \${detail}\`);
}
`;
  const serverDir = path.join(bundleRoot, "server");
  mkdirSync(serverDir, { recursive: true });
  writeFileSync(path.join(serverDir, "lodestone-mcpb-launcher.js"), launcher);
}

function writeReadme(bundleRoot, profile, manifestOnly) {
  const readme = `# Lodestone Claude Desktop MCPB

This bundle runs Lodestone's local MCP server inside Claude Desktop.

- Profile: ${profile}
- Platform: ${process.platform}
- Version: ${VERSION}
- Distribution: ${manifestOnly ? "manifest-only smoke artifact; do not distribute" : "private current-platform MCPB"}

Install in Claude Desktop, then choose the repository folder where Lodestone has
already been initialized and indexed. The selected project must contain
\`.lodestone/lodestone.toml\`.

This bundle runs locally. It does not send repository code or telemetry to
CMNDI.
`;
  writeFileSync(path.join(bundleRoot, "README.md"), readme);
}

function packageTarballs(profile, tarballDir, skipDocs) {
  const env = {
    ...process.env,
    ...(skipDocs ? { LODESTONE_SKIP_DOCS_BUILD: "1" } : {}),
  };
  run("bash", ["scripts/pack-profile.sh", profile, "--out-dir", tarballDir], { env });
}

function installRuntimeDependencies(profile, tarballDir, installDir) {
  const tarballs = [
    path.join(tarballDir, `lodestone-shared-${VERSION}.tgz`),
    path.join(tarballDir, `lodestone-ingest-${VERSION}-${profile}.tgz`),
    path.join(tarballDir, `lodestone-mcp-server-${VERSION}.tgz`),
  ];
  for (const tarball of tarballs) {
    if (!existsSync(tarball)) fail(`expected tarball missing: ${tarball}`);
  }

  mkdirSync(installDir, { recursive: true });
  writeFileSync(
    path.join(installDir, "package.json"),
    JSON.stringify(
      {
        private: true,
        type: "module",
        dependencies: {},
      },
      null,
      2,
    ) + "\n",
  );
  run(
    "npm",
    [
      "install",
      "--omit=dev",
      "--package-lock=false",
      "--fund=false",
      "--audit=false",
      ...tarballs,
    ],
    { cwd: installDir },
  );
}

function copyRuntimeDependencies(installDir, bundleRoot, manifestOnly) {
  writeFileSync(
    path.join(bundleRoot, "package.json"),
    JSON.stringify(
      {
        name: "lodestone-claude-desktop-bundle-runtime",
        private: true,
        type: "module",
        version: VERSION,
        dependencies: {
          "@lodestone/mcp-server": VERSION,
        },
      },
      null,
      2,
    ) + "\n",
  );

  if (manifestOnly) {
    return;
  }

  const source = path.join(installDir, "node_modules");
  if (!existsSync(source)) fail(`node_modules was not created at ${source}`);
  pruneCurrentPlatformNativePayloads(source);
  cpSync(source, path.join(bundleRoot, "node_modules"), {
    recursive: true,
    dereference: true,
  });
}

function nativeArchDir() {
  return process.arch;
}

function pruneCurrentPlatformNativePayloads(nodeModules) {
  const ortPackages = [
    path.join(nodeModules, "onnxruntime-node"),
    path.join(
      nodeModules,
      "@xenova",
      "transformers",
      "node_modules",
      "onnxruntime-node",
    ),
  ];

  for (const ortPackage of ortPackages) {
    pruneOnnxRuntimePackage(ortPackage);
  }
}

function pruneOnnxRuntimePackage(ortPackage) {
  const binDir = path.join(ortPackage, "bin");
  if (!existsSync(binDir)) return;

  for (const napiName of readdirSync(binDir)) {
    const napiPath = path.join(binDir, napiName);
    if (!statSync(napiPath).isDirectory() || !napiName.startsWith("napi-v")) {
      continue;
    }
    pruneOnnxRuntimeRoot(napiPath);
  }
}

function pruneOnnxRuntimeRoot(root) {
  if (!existsSync(root)) return;
  const keepPlatform = process.platform;
  const keepArch = nativeArchDir();

  for (const platformName of readdirSync(root)) {
    const platformPath = path.join(root, platformName);
    if (!statSync(platformPath).isDirectory()) continue;
    if (platformName !== keepPlatform) {
      rmSync(platformPath, { recursive: true, force: true });
      continue;
    }

    for (const archName of readdirSync(platformPath)) {
      const archPath = path.join(platformPath, archName);
      if (!statSync(archPath).isDirectory()) continue;
      if (archName !== keepArch) {
        rmSync(archPath, { recursive: true, force: true });
        continue;
      }
      pruneGpuProviderLibraries(archPath);
    }
  }
}

function pruneGpuProviderLibraries(nativeDir) {
  for (const name of readdirSync(nativeDir)) {
    if (/cuda|tensorrt/i.test(name)) {
      rmSync(path.join(nativeDir, name), { force: true });
    }
  }
}

function createZip(sourceDir, outFile) {
  const zipScript = `
import os
import stat
import sys
import time
import zipfile

source, target = sys.argv[1], sys.argv[2]
epoch = int(os.environ.get("SOURCE_DATE_EPOCH", str(int(time.time()))))
dt = time.gmtime(epoch)
zip_dt = (max(1980, min(2107, dt.tm_year)), dt.tm_mon, dt.tm_mday, dt.tm_hour, dt.tm_min, dt.tm_sec)

with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as zf:
    for root, dirs, files in os.walk(source):
        dirs[:] = sorted(d for d in dirs if d not in {"__pycache__"})
        for name in sorted(files):
            if name in {".DS_Store"}:
                continue
            abs_path = os.path.join(root, name)
            rel_path = os.path.relpath(abs_path, source).replace(os.sep, "/")
            info = zipfile.ZipInfo(rel_path, zip_dt)
            mode = os.stat(abs_path).st_mode
            perms = 0o755 if mode & stat.S_IXUSR else 0o644
            info.external_attr = perms << 16
            with open(abs_path, "rb") as handle:
                zf.writestr(info, handle.read())
`;
  execFileSync("python3", ["-c", zipScript, sourceDir, outFile], {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: "inherit",
  });
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "lodestone-mcpb-"));
  const tarballDir = path.join(tmpRoot, "tarballs");
  const installDir = path.join(tmpRoot, "install");
  const bundleRoot = path.join(tmpRoot, "bundle");
  mkdirSync(bundleRoot, { recursive: true });

  try {
    if (!opts.skipBuild && !opts.manifestOnly) {
      run("pnpm", ["-r", "build"]);
    }

    if (!opts.manifestOnly) {
      packageTarballs(opts.profile, tarballDir, opts.skipDocs);
      installRuntimeDependencies(opts.profile, tarballDir, installDir);
    }

    const manifest = makeManifest(opts.profile);
    validateManifest(manifest);
    writeFileSync(path.join(bundleRoot, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    writeLauncher(bundleRoot);
    writeReadme(bundleRoot, opts.profile, opts.manifestOnly);
    copyRuntimeDependencies(installDir, bundleRoot, opts.manifestOnly);

    mkdirSync(opts.outDir, { recursive: true });
    const manifestSuffix = opts.manifestOnly ? "-manifest-only" : "";
    const outFile = path.join(
      opts.outDir,
      `lodestone-claude-desktop-${VERSION}-${opts.profile}-${process.platform}${manifestSuffix}.mcpb`,
    );
    rmSync(outFile, { force: true });
    createZip(bundleRoot, outFile);

    if (opts.manifestOnly) {
      log(`wrote structural smoke artifact: ${outFile}`);
      log("manifest-only artifacts are not distribution-ready because node_modules is omitted");
    } else {
      log(`wrote private current-platform bundle: ${outFile}`);
    }
  } finally {
    if (opts.keepStaging) {
      log(`kept staging directory: ${tmpRoot}`);
    } else {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }
}

main();

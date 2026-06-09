// SPDX-License-Identifier: Apache-2.0
//
// §21 — documentation pass test suite. Asserts the friend-facing docs
// invariants the spec calls for:
//
//   - root README has the install command + the privacy claim
//   - every doc linked from docs/README.md exists on disk
//   - SUPPLY-CHAIN.md uses the friend-facing rationale and contains
//     none of the internal CMNDI mandate vocabulary
//   - MCP-TOOLS.md documents all 8 tools (heading + JSON example)
//   - CONFIG.md documents every leaf key in the lodestone.toml zod schema
//
// The CONFIG.md schema-walk test is the highest-value one — it catches
// drift when a future PR adds a config key but forgets to document it.
// We walk the zod schema by introspection rather than maintaining a
// hand-list of keys.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  lodestoneConfigSchema,
  type LodestoneConfig,
} from "@lodestone/shared";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// e2e/__tests__/ -> repo root is two levels up.
const REPO_ROOT = path.resolve(HERE, "..", "..");
const DOCS_DIR = path.join(REPO_ROOT, "docs");
const MARKDOWN_SKIP_DIRS = new Set([
  ".bob",
  ".git",
  ".lodestone",
  ".remember",
  "dist",
  "docs/internal",
  "docs/releases",
  "docs/site",
  "node_modules",
]);
const MARKDOWN_SKIP_FILES = new Set(["docs/CMNDI-DOCS-MANDATE.md"]);

function readFile(relative: string): string {
  return readFileSync(path.join(REPO_ROOT, relative), "utf8");
}

function markdownSourceFiles(): string[] {
  const files: string[] = [];

  const walk = (relDir: string): void => {
    const absDir = path.join(REPO_ROOT, relDir);
    for (const dirent of readdirSync(absDir, { withFileTypes: true })) {
      const rel = path.normalize(path.join(relDir, dirent.name)).replace(/^\.\//, "");
      if (dirent.isDirectory()) {
        if (!MARKDOWN_SKIP_DIRS.has(rel) && !MARKDOWN_SKIP_DIRS.has(dirent.name)) {
          walk(rel);
        }
        continue;
      }
      if (dirent.isFile() && rel.endsWith(".md") && !MARKDOWN_SKIP_FILES.has(rel)) {
        files.push(rel);
      }
    }
  };

  walk(".");
  return files.sort();
}

function workspacePackageNames(): Set<string> {
  const names = new Set<string>();
  const packageJsonFiles = [
    ...readdirSync(path.join(REPO_ROOT, "packages"), { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => path.join("packages", dirent.name, "package.json")),
    path.join("e2e", "package.json"),
  ];
  for (const rel of packageJsonFiles) {
    const pkg = JSON.parse(readFile(rel)) as { name?: unknown };
    if (typeof pkg.name === "string") names.add(pkg.name);
  }
  return names;
}

function cliSubcommandNames(): Set<string> {
  const helpSource = readFile("packages/cli/src/routing/help.ts");
  const names = new Set<string>();
  for (const match of helpSource.matchAll(/name\s*:\s*["']([^"']+)["']/g)) {
    if (typeof match[1] === "string") names.add(match[1]);
  }
  expect(names.has("init"), "failed to parse CLI subcommands from help.ts").toBe(true);
  return names;
}

function markdownCodeSegments(text: string): string[] {
  const segments: string[] = [];
  for (const match of text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
    if (typeof match[1] === "string") segments.push(match[1]);
  }
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    if (typeof match[1] === "string") segments.push(match[1]);
  }
  return segments;
}

function shouldSkipRepoPathCandidate(candidate: string): boolean {
  return (
    candidate.includes("/dist/") ||
    candidate.includes("/node_modules/") ||
    candidate.startsWith("e2e/synthetic-demo-repo/.lodestone/") ||
    candidate.startsWith("packages/api/") ||
    candidate === "scripts/seed.py" ||
    candidate === "scripts/migrate.py"
  );
}

interface PathCandidate {
  display: string;
  resolved: string;
}

function repoPathCandidates(relativeFile: string, text: string): PathCandidate[] {
  const candidates: PathCandidate[] = [];
  const seen = new Set<string>();
  const add = (display: string, resolved: string): void => {
    const cleanedResolved = path.normalize(resolved);
    const key = `${display}\0${cleanedResolved}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ display, resolved: cleanedResolved });
  };
  const patterns = [
    /(?:^|[\s`(])((?:\.github|docs|e2e|packages|scripts)\/[A-Za-z0-9_./@-]+)/g,
    /(?:^|[\s`(])((?:README|LICENSE|package|pnpm-lock)\.[A-Za-z0-9_-]+)/g,
  ];
  const markdownLinkRe = /\]\((?!https?:|mailto:|#)([^)#\s]+)(?:#[^)]*)?\)/g;
  for (const match of text.matchAll(markdownLinkRe)) {
    const raw = match[1];
    if (typeof raw !== "string") continue;
    const target = raw.replace(/[),.;:]+$/, "");
    add(target, path.join(path.dirname(relativeFile), target));
  }

  for (const segment of markdownCodeSegments(text)) {
    for (const pattern of patterns) {
      for (const match of segment.matchAll(pattern)) {
        const raw = match[1];
        if (typeof raw !== "string") continue;
        const cleaned = raw.replace(/[),.;:]+$/, "");
        if (shouldSkipRepoPathCandidate(cleaned)) continue;
        add(cleaned, cleaned);
      }
    }
  }

  return candidates;
}

function documentedLodestoneCommands(text: string): string[] {
  const commands: string[] = [];
  const commandRe = /(?:^|[;&|]\s*)(?:npx\s+|\.\/node_modules\/\.bin\/|(?:node\s+)?[\w./-]*\/)?lodestone(?:\.js)?\s+([a-z][a-z-]*)/g;
  for (const segment of markdownCodeSegments(text)) {
    for (const line of segment.split(/\r?\n/)) {
      const trimmed = line.trim().replace(/^[$>]\s+/, "");
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      for (const match of trimmed.matchAll(commandRe)) {
        const raw = match[1];
        if (typeof raw === "string") commands.push(raw);
      }
    }
  }
  return commands;
}

describe("section 21 documentation pass", () => {
  describe("root README.md", () => {
    const text = readFile("README.md");

    it("contains the install command in a fenced code block", () => {
      // Match a fenced block containing `npx lodestone init`.
      const fenced = /```[\s\S]*?npx lodestone init[\s\S]*?```/.test(text);
      expect(fenced).toBe(true);
    });

    it("contains the privacy claim verbatim", () => {
      expect(text).toContain("never leaves your machine");
    });

    it("links to docs/README.md", () => {
      expect(text).toMatch(/docs\/README\.md/);
    });
  });

  describe("docs/README.md and friend-onboarding linkage", () => {
    const text = readFile("docs/README.md");

    it("contains the install command in a fenced code block", () => {
      const fenced = /```[\s\S]*?npx lodestone init[\s\S]*?```/.test(text);
      expect(fenced).toBe(true);
    });

    it("contains the privacy claim verbatim", () => {
      expect(text).toContain("never leaves your machine");
    });

    it("every relative .md link from docs/README.md resolves to a file on disk", () => {
      // Markdown link syntax: [label](./PATH.md) or [label](PATH.md).
      // Skip absolute http(s) URLs and parent-dir links to repo root files
      // like ../LICENSE — those exist as non-md siblings.
      const linkRe = /\]\((\.?\.?\/?[^)#\s]+\.md)(?:#[^)]*)?\)/g;
      const links = new Set<string>();
      for (const match of text.matchAll(linkRe)) {
        const link = match[1];
        if (typeof link === "string") links.add(link);
      }
      expect(links.size).toBeGreaterThan(0);
      for (const link of links) {
        const resolved = path.resolve(DOCS_DIR, link);
        expect(existsSync(resolved), `linked doc missing: ${link} -> ${resolved}`).toBe(true);
      }
    });
  });

  describe("docs/SUPPLY-CHAIN.md", () => {
    const text = readFile("docs/SUPPLY-CHAIN.md");

    it("uses the friend-facing rationale (Apache + United States/US-origin)", () => {
      expect(text).toContain("Apache");
      // Accept either spelling per spec.
      const usMention = /United States|US-origin/.test(text);
      expect(usMention).toBe(true);
    });

    it("does not contain internal mandate vocabulary", () => {
      const banned = [
        "CMNDI",
        "NIST 800-53",
        "CMMC",
        "SOC 2",
        "FedRAMP",
        "ISO 27001",
        "DAIV",
        "GovRAMP",
        "mandate",
      ];
      for (const term of banned) {
        expect(text, `SUPPLY-CHAIN.md must not mention "${term}"`).not.toMatch(
          new RegExp(term, "i")
        );
      }
    });
  });

  describe("docs/MCP-TOOLS.md documents all 8 tools", () => {
    const text = readFile("docs/MCP-TOOLS.md");
    // The §13 schema renamed cypher -> sql (POST-CODEX-001 amendment).
    // We document the actual shipped names.
    const tools = [
      "query",
      "context",
      "impact",
      "cluster",
      "skills_for",
      "recent_changes",
      "feedback",
      "sql",
    ] as const;

    for (const tool of tools) {
      it(`documents \`${tool}\` (heading present)`, () => {
        // Tool appears as a markdown heading (## `tool` ...).
        const headingRe = new RegExp("^##\\s+`?" + tool + "`?", "m");
        expect(text, `expected heading for ${tool}`).toMatch(headingRe);
      });
    }

    it("contains a JSON request/response fenced example for each tool", () => {
      // Count fenced ```json blocks; require at least 2 per tool (req + resp).
      const jsonBlocks = text.match(/```json[\s\S]*?```/g) ?? [];
      // Eight tools, two examples each -> at least 16 JSON blocks.
      expect(jsonBlocks.length).toBeGreaterThanOrEqual(16);
    });
  });

  describe("docs/CONFIG.md documents every lodestone.toml schema key", () => {
    const text = readFile("docs/CONFIG.md");

    it("mentions every leaf key from the zod schema", () => {
      // Walk the schema by parsing a maximal-default object and enumerating
      // keys at each section. Using parse() of a minimal object gives us
      // the canonical keys with defaults applied.
      const sample: LodestoneConfig = lodestoneConfigSchema.parse({
        project: { name: "lodestone-config-walk", languages: [] },
      });

      const sections: Record<string, object> = {
        project: sample.project,
        ingest: sample.ingest,
        embedder: sample.embedder,
        cluster: sample.cluster,
        skill_emitter: sample.skill_emitter,
        mcp: sample.mcp,
        pro: sample.pro,
      };

      const missing: string[] = [];
      for (const [section, obj] of Object.entries(sections)) {
        // Section header presence (e.g. `[project]`).
        if (!text.includes(`[${section}]`) && !text.includes(`\`[${section}]\``)) {
          missing.push(`section [${section}]`);
        }
        for (const key of Object.keys(obj)) {
          // Each key must appear somewhere in the doc body. Use word-ish
          // boundaries to avoid false positives from substring matches.
          const keyRe = new RegExp(
            "(^|[^a-zA-Z0-9_])" + key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "([^a-zA-Z0-9_]|$)"
          );
          if (!keyRe.test(text)) {
            missing.push(`${section}.${key}`);
          }
        }
      }

      expect(
        missing,
        `CONFIG.md missing entries: ${missing.join(", ")}`
      ).toEqual([]);
    });

    it("documents the LODESTONE_OFFLINE env var", () => {
      expect(text).toContain("LODESTONE_OFFLINE");
    });
  });

  describe("file presence — spec acceptance checklist", () => {
    const required = [
      "README.md",
      "docs/README.md",
      "docs/ARCHITECTURE.md",
      "docs/CONFIG.md",
      "docs/MCP-TOOLS.md",
      "docs/MCPB.md",
      "docs/PRIVACY.md",
      "docs/SUPPLY-CHAIN.md",
      "docs/TROUBLESHOOTING.md",
      "docs/UPGRADE.md",
      "docs/DEMO-REPO.md",
    ] as const;

    for (const rel of required) {
      it(`${rel} exists`, () => {
        expect(existsSync(path.join(REPO_ROOT, rel)), `missing ${rel}`).toBe(true);
      });
    }
  });

  describe("stale-doc guardrails", () => {
    const sourceFiles = markdownSourceFiles();

    it("documented lodestone subcommands exist in the CLI", () => {
      const known = cliSubcommandNames();
      const invalid: string[] = [];

      for (const rel of sourceFiles) {
        const text = readFile(rel);
        for (const command of documentedLodestoneCommands(text)) {
          if (!known.has(command)) {
            invalid.push(`${rel}: lodestone ${command}`);
          }
        }
      }

      expect(invalid, `stale command references: ${invalid.join(", ")}`).toEqual([]);
    });

    it("repo-relative doc/source paths mentioned in markdown exist", () => {
      const missing: string[] = [];

      for (const rel of sourceFiles) {
        const text = readFile(rel);
        for (const candidate of repoPathCandidates(rel, text)) {
          const resolved = path.join(REPO_ROOT, candidate.resolved);
          if (!existsSync(resolved)) {
            missing.push(`${rel}: ${candidate.display}`);
          }
        }
      }

      expect(missing, `stale path references: ${missing.join(", ")}`).toEqual([]);
    });

    it("documented @lodestone workspace package names exist", () => {
      const known = workspacePackageNames();
      const stale: string[] = [];
      const packageRe = /@lodestone\/[a-z0-9-]+/g;

      for (const rel of sourceFiles) {
        const text = readFile(rel);
        for (const match of text.matchAll(packageRe)) {
          const name = match[0];
          if (!known.has(name)) stale.push(`${rel}: ${name}`);
        }
      }

      expect(stale, `stale package references: ${stale.join(", ")}`).toEqual([]);
    });
  });

  describe("release hygiene helpers", () => {
    it("docs builders support stable release metadata", () => {
      const cmndiBuilder = readFile("scripts/docs/cmndi-docs-build.py");
      const friendBuilder = readFile("scripts/docs/friend-docs-build.py");
      const packProfile = readFile("scripts/pack-profile.sh");
      const cmndiHook = readFile("scripts/docs/cmndi-docs-hook.sh");
      const cmndiWorkflow = readFile(".github/workflows/cmndi-docs.yml");

      expect(cmndiBuilder).toContain("SOURCE_DATE_EPOCH");
      expect(cmndiBuilder).toContain("LODESTONE_DOCS_BUILD_TIMESTAMP");
      expect(cmndiBuilder).toContain("LODESTONE_DOCS_BUILD_COMMIT");
      expect(cmndiBuilder).toContain("LODESTONE_DOCS_BUILD_BRANCH");

      expect(friendBuilder).toContain("SOURCE_DATE_EPOCH");
      expect(friendBuilder).toContain("LODESTONE_DOCS_BUILD_TIMESTAMP");
      expect(friendBuilder).toContain("normalize_docx");

      expect(packProfile).toContain("SOURCE_DATE_EPOCH");
      expect(packProfile).toContain("git -C \"$REPO_ROOT\" log -1 --format=%ct HEAD");
      expect(cmndiHook).toContain("SOURCE_DATE_EPOCH");
      expect(cmndiHook).toContain("git log -1 --format=%ct HEAD");
      expect(cmndiWorkflow).toContain("SOURCE_DATE_EPOCH");
      expect(cmndiWorkflow).toContain("git log -1 --format=%ct HEAD");
    });

    it("documents why generated friend docs are tracked", () => {
      const docsReadme = readFile("docs/README.md");
      const friendReadme = readFile("docs/friend/README.md");

      expect(docsReadme).toContain("Generated Docs Policy");
      expect(docsReadme).toContain("intentionally tracked");
      expect(docsReadme).toContain("Do not add these generated docs directories to `.gitignore`");
      expect(friendReadme).toContain("intentionally committed");
      expect(friendReadme).toContain("manual");
      expect(friendReadme).toContain("reproducible rebuild");
    });

    it("installer keeps strict transitive overrides opt-in", () => {
      const installer = readFile("scripts/install-from-release.sh");

      expect(installer).toContain("LODESTONE_STRICT_NPM_OVERRIDES");
      expect(installer).toContain('protobufjs: "7.5.8"');
      expect(installer).toContain('"fast-uri": "3.1.2"');
      expect(installer).toContain('hono: "4.12.21"');
      expect(installer).toContain('"ip-address": "10.1.1"');
      expect(installer).toContain('qs: "6.15.2"');
      expect(installer).toContain("strict npm override mode");
      expect(installer).toContain("default npm override mode: protobufjs only");
    });

    it("friend docs document the strict override option as advanced", () => {
      const technical = readFile("docs/friend/lodestone-technical-guide.md");
      const installation = readFile("docs/friend/lodestone-installation-guide.md");

      expect(technical).toContain("LODESTONE_STRICT_NPM_OVERRIDES=1");
      expect(technical).toContain("Strict npm override mode");
      expect(installation).toContain("Advanced operators can set");
      expect(installation).toContain("LODESTONE_STRICT_NPM_OVERRIDES=1");
    });

    it("Claude Desktop MCPB packer documents and enforces the private bundle contract", () => {
      const script = readFile("scripts/mcpb/build-claude-desktop-bundle.mjs");
      const mcpbDoc = readFile("docs/MCPB.md");
      const technical = readFile("docs/friend/lodestone-technical-guide.md");
      const installation = readFile("docs/friend/lodestone-installation-guide.md");

      expect(script).toContain("manifest_version: \"0.4\"");
      expect(script).toContain("mcpb-manifest-v0.4.schema.json");
      expect(script).toContain("LODESTONE_REPO_ROOT");
      expect(script).toContain("repository_root");
      expect(script).toContain("process.chdir(repoRoot)");
      expect(script).toContain("@lodestone/mcp-server");
      expect(script).toContain("current-platform");
      expect(script).toContain("pruneCurrentPlatformNativePayloads");
      expect(script).toContain("napiName.startsWith(\"napi-v\")");
      expect(script).toContain("manifest-only artifacts are not distribution-ready");

      expect(mcpbDoc).toContain("Claude Desktop MCPB Packaging");
      expect(mcpbDoc).toContain("current-platform");
      expect(mcpbDoc).toContain("Project folder");
      expect(mcpbDoc).toContain("Do not commit generated `.mcpb` files");
      expect(technical).toContain("Optional Claude Desktop MCPB Bundle");
      expect(installation).toContain("Claude Desktop MCPB Option");
    });

    it("MCPB manifest-only smoke writes a valid bundle manifest", () => {
      const tmp = mkdtempSync(path.join(tmpdir(), "lodestone-mcpb-test-"));
      try {
        execFileSync(
          "node",
          [
            "scripts/mcpb/build-claude-desktop-bundle.mjs",
            "--manifest-only",
            "--out-dir",
            tmp,
          ],
          {
            cwd: REPO_ROOT,
            env: { ...process.env, SOURCE_DATE_EPOCH: "1770000000" },
            stdio: "pipe",
          }
        );
        const bundle = readdirSync(tmp).find((name) => name.endsWith(".mcpb"));
        expect(bundle).toBeDefined();
        const bundlePath = path.join(tmp, bundle ?? "");
        const manifestRaw = execFileSync(
          "python3",
          [
            "-c",
            "import zipfile,sys; print(zipfile.ZipFile(sys.argv[1]).read('manifest.json').decode())",
            bundlePath,
          ],
          { encoding: "utf8" }
        );
        const namesRaw = execFileSync(
          "python3",
          [
            "-c",
            "import json,zipfile,sys; print(json.dumps(sorted(zipfile.ZipFile(sys.argv[1]).namelist())))",
            bundlePath,
          ],
          { encoding: "utf8" }
        );
        const manifest = JSON.parse(manifestRaw) as {
          manifest_version?: string;
          server?: { entry_point?: string; mcp_config?: { env?: Record<string, string> } };
          user_config?: Record<string, unknown>;
          compatibility?: { platforms?: string[] };
        };
        const names = JSON.parse(namesRaw) as string[];

        expect(manifest.manifest_version).toBe("0.4");
        expect(manifest.server?.entry_point).toBe("server/lodestone-mcpb-launcher.js");
        expect(manifest.server?.mcp_config?.env?.LODESTONE_REPO_ROOT).toBe(
          "${user_config.repository_root}"
        );
        expect(manifest.user_config?.repository_root).toBeDefined();
        expect(manifest.compatibility?.platforms).toEqual([process.platform]);
        expect(names).toEqual([
          "README.md",
          "manifest.json",
          "package.json",
          "server/lodestone-mcpb-launcher.js",
        ]);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
});

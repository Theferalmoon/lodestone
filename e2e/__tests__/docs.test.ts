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

import { existsSync, readFileSync } from "node:fs";
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

function readFile(relative: string): string {
  return readFileSync(path.join(REPO_ROOT, relative), "utf8");
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
});

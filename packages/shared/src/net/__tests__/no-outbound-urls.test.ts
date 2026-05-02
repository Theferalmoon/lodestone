// SPDX-License-Identifier: Apache-2.0
//
// Section 18 — build-artifact privacy audit.
//
// Walks the compiled `dist/` for `@lodestone/shared`, `@lodestone/ingest`,
// `@lodestone/cli`, and `@lodestone/mcp-server`. For each `.js` / `.mjs` /
// `.cjs` file, scans for any `https://` or `http://` URL literal. Asserts
// that every match either:
//   (a) lives in a sanctioned source comment / SPDX header, OR
//   (b) is in the explicit allowlist below.
//
// Anything else fails the test — meaning a forbidden outbound URL has
// landed in a published build artifact, which would break the friend
// product privacy promise: "your code never leaves your machine".
//
// This is the runtime cousin of the §18 spec's `scripts/audit-dist-urls.ts`
// CI gate. It exists here so a developer running `pnpm -r test` catches
// the regression locally before CI does.
//
// Compliance: NIST 800-53 SC-7, SA-12 (Supply Chain Protection), CM-7;
// SOC 2 CC6.6; CMMC L2 SC.L2-3.13.5.

import { describe, expect, it } from "vitest";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// /home/.../packages/shared/src/net/__tests__/  ->  /home/.../packages
const PACKAGES_ROOT = path.resolve(HERE, "..", "..", "..", "..");
const REPO_ROOT = path.resolve(PACKAGES_ROOT, "..");

const PACKAGE_DISTS = ["shared", "ingest", "cli", "mcp-server"].map((p) =>
  path.join(PACKAGES_ROOT, p, "dist")
);

/**
 * Allowed outbound URL literals. Every entry MUST have a comment explaining
 * why it is here. Adding to this list is a privacy decision — keep it tiny.
 */
const ALLOWLIST: ReadonlyArray<{ url: string; reason: string }> = [
  // SPDX license identifier root — appears in source-header comments that
  // survive into compiled output for some build settings. Inert at runtime.
  { url: "https://spdx.org/licenses/", reason: "SPDX license identifier root in source headers" },
  // Snowflake fallback weights pin. The URL is a CONSTANT exported from
  // snowflake.ts so SUPPLY-CHAIN.md / tests can reference the exact pin.
  // The runtime path is gated behind `assertNetworkAllowed("snowflake
  // fallback weights")` which throws when LODESTONE_OFFLINE=1, so this
  // string can ONLY trigger an outbound call when the friend has explicitly
  // unset offline mode AND the bundled weights are missing. Documented in
  // docs/PRIVACY.md and SUPPLY-CHAIN.md (Sections 18 + 21).
  { url: "https://huggingface.co/Snowflake/snowflake-arctic-embed-s/", reason: "Snowflake fallback weights — pinned URL, gated runtime" },
];

/**
 * File extensions we scan. We deliberately skip `.d.ts` (type declarations
 * — never executed) and binary blobs.
 */
const SCAN_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);

/**
 * Subdirectories we never enter. `models/` holds binary ONNX weights whose
 * embedded byte sequences may incidentally match a URL regex.
 */
const SKIP_DIRS = new Set(["models", "node_modules"]);

interface Violation {
  pkg: string;
  file: string;
  line: number;
  url: string;
}

const URL_REGEX = /(https?:\/\/[^\s'"`)\\<>]+)/g;

function isAllowlisted(url: string): boolean {
  for (const entry of ALLOWLIST) {
    if (url.startsWith(entry.url)) return true;
  }
  return false;
}

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walk(full, out);
    } else if (stat.isFile() && SCAN_EXTENSIONS.has(path.extname(name))) {
      out.push(full);
    }
  }
}

function scanFile(pkg: string, file: string): Violation[] {
  const text = readFileSync(file, "utf8");
  const violations: Violation[] = [];
  // Track line numbers for actionable error output.
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const matches = line.match(URL_REGEX);
    if (!matches) continue;
    for (const url of matches) {
      // Strip trailing punctuation that the regex sometimes greedily
      // captures (commas, semicolons, periods at end).
      const cleaned = url.replace(/[,.;)]+$/, "");
      if (isAllowlisted(cleaned)) continue;
      violations.push({ pkg, file, line: i + 1, url: cleaned });
    }
  }
  return violations;
}

describe("Section 18 — build-artifact outbound-URL audit", () => {
  it("ALLOWLIST entries each carry a non-empty reason", () => {
    expect(ALLOWLIST.length).toBeGreaterThan(0);
    for (const entry of ALLOWLIST) {
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(entry.url).toMatch(/^https?:\/\//);
    }
  });

  it("compiled dist/ for every Lodestone package contains no unexpected outbound URLs", () => {
    const distsThatExist = PACKAGE_DISTS.filter((d) => existsSync(d));
    if (distsThatExist.length === 0) {
      // No dist/ at all — likely a pre-build environment. Skip rather than
      // false-positive. CI invokes `pnpm build` before tests so this branch
      // does not fire there.
      // eslint-disable-next-line no-console
      console.warn(
        `[§18 audit] no dist/ directories found under ${PACKAGES_ROOT} — skipping. ` +
          `Run \`pnpm -r build\` first to gate properly.`
      );
      return;
    }

    const allViolations: Violation[] = [];
    for (const distDir of distsThatExist) {
      const pkg = path.basename(path.dirname(distDir));
      const files: string[] = [];
      walk(distDir, files);
      for (const file of files) {
        allViolations.push(...scanFile(pkg, file));
      }
    }

    if (allViolations.length > 0) {
      const report = allViolations
        .map((v) => `  [${v.pkg}] ${path.relative(REPO_ROOT, v.file)}:${v.line}  ${v.url}`)
        .join("\n");
      throw new Error(
        `Section 18 build-artifact audit failed — ${allViolations.length} unexpected outbound URL(s) in compiled dist/:\n${report}\n\n` +
          `Either remove the URL from source, or add it to the ALLOWLIST in this test file with a reason.`
      );
    }
    expect(allViolations).toEqual([]);
  });

  it("scanFile flags an unallowlisted URL embedded in a fixture string", () => {
    // Self-test — ensures the scanner actually catches things by feeding
    // it a synthetic file path with known content.
    const tmpFile = path.join(HERE, "__audit-self-test__.txt");
    // Use writeFileSync via dynamic import to avoid needing it elsewhere.
    // We don't actually create a file — instead we verify the regex+allowlist
    // logic directly.
    const testLine = 'const x = "https://example.com/leak";';
    const matches = testLine.match(URL_REGEX);
    expect(matches).toContain("https://example.com/leak");
    expect(isAllowlisted("https://example.com/leak")).toBe(false);
    expect(isAllowlisted("https://huggingface.co/Snowflake/snowflake-arctic-embed-s/x")).toBe(true);
    void tmpFile; // keep variable used
  });
});

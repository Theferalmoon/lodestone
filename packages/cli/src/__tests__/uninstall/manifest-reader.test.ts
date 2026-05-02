// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readInstallManifest } from "../../uninstall/manifest-reader.js";

describe("readInstallManifest", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "lodestone-manifest-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns missing when .lodestone/install-manifest.json absent", () => {
    const r = readInstallManifest(tmp);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("missing");
  });

  it("returns invalid-json when manifest is corrupt", () => {
    mkdirSync(path.join(tmp, ".lodestone"), { recursive: true });
    writeFileSync(path.join(tmp, ".lodestone", "install-manifest.json"), "{not json");
    const r = readInstallManifest(tmp);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid-json");
  });

  it("returns schema-mismatch when schema_version is below v1 (unknown low version)", () => {
    mkdirSync(path.join(tmp, ".lodestone"), { recursive: true });
    writeFileSync(
      path.join(tmp, ".lodestone", "install-manifest.json"),
      JSON.stringify({ schema_version: 0, installed_at: "x", mcp_json: { action: "y" }, claude_md: { action: "z" }, gitignore: { action: "w" } })
    );
    const r = readInstallManifest(tmp);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("schema-mismatch");
  });

  it("returns future-schema when schema_version exceeds the binary's max (Codex §19 YELLOW)", () => {
    mkdirSync(path.join(tmp, ".lodestone"), { recursive: true });
    writeFileSync(
      path.join(tmp, ".lodestone", "install-manifest.json"),
      JSON.stringify({ schema_version: 999, installed_at: "x", mcp_json: { action: "y" }, claude_md: { action: "z" }, gitignore: { action: "w" } })
    );
    const r = readInstallManifest(tmp);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("future-schema");
      expect(r.detail).toMatch(/newer than this binary/i);
    }
  });

  it("returns schema-mismatch when required fields missing", () => {
    mkdirSync(path.join(tmp, ".lodestone"), { recursive: true });
    writeFileSync(
      path.join(tmp, ".lodestone", "install-manifest.json"),
      JSON.stringify({ schema_version: 1, installed_at: "x" }) // missing all 3 actions
    );
    const r = readInstallManifest(tmp);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("schema-mismatch");
  });

  it("returns schema-mismatch when mcp_json.action is not a string", () => {
    mkdirSync(path.join(tmp, ".lodestone"), { recursive: true });
    writeFileSync(
      path.join(tmp, ".lodestone", "install-manifest.json"),
      JSON.stringify({
        schema_version: 1,
        installed_at: "x",
        mcp_json: { action: 42 },
        claude_md: { action: "skipped" },
        gitignore: { action: "noop" },
      })
    );
    const r = readInstallManifest(tmp);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("schema-mismatch");
  });

  it("returns ok with parsed manifest on a valid v1 file (upgraded to v2 in-memory)", () => {
    mkdirSync(path.join(tmp, ".lodestone"), { recursive: true });
    const manifest = {
      schema_version: 1,
      installed_at: "2026-05-01T00:00:00.000Z",
      mcp_json: { action: "created", path: "/x" },
      claude_md: { action: "skipped" },
      gitignore: { action: "created", path: "/y" },
    };
    writeFileSync(
      path.join(tmp, ".lodestone", "install-manifest.json"),
      JSON.stringify(manifest)
    );
    const r = readInstallManifest(tmp);
    expect(r.ok).toBe(true);
    if (r.ok) {
      // v1 on disk is normalized to the v2 in-memory shape so the rest
      // of uninstall sees one canonical type. v1 had no concept of a
      // failed install, so the upgrade defaults `install_state` to
      // `complete`.
      expect(r.manifest.schema_version).toBe(2);
      expect(r.manifest.install_state).toBe("complete");
      expect(r.manifest.reindex_state).toBeUndefined();
    }
  });

  it("returns ok with parsed manifest on a valid v2 file with install_state=pending", () => {
    mkdirSync(path.join(tmp, ".lodestone"), { recursive: true });
    const manifest = {
      schema_version: 2,
      installed_at: "2026-05-01T00:00:00.000Z",
      install_state: "pending",
      mcp_json: { action: "created", path: "/x" },
      claude_md: { action: "skipped" },
      gitignore: { action: "created", path: "/y" },
    };
    writeFileSync(
      path.join(tmp, ".lodestone", "install-manifest.json"),
      JSON.stringify(manifest)
    );
    const r = readInstallManifest(tmp);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.schema_version).toBe(2);
      expect(r.manifest.install_state).toBe("pending");
    }
  });

  it("returns ok and propagates reindex_state on v2 manifests", () => {
    mkdirSync(path.join(tmp, ".lodestone"), { recursive: true });
    const manifest = {
      schema_version: 2,
      installed_at: "2026-05-01T00:00:00.000Z",
      install_state: "complete",
      reindex_state: "failed",
      mcp_json: { action: "created", path: "/x" },
      claude_md: { action: "skipped" },
      gitignore: { action: "created", path: "/y" },
    };
    writeFileSync(
      path.join(tmp, ".lodestone", "install-manifest.json"),
      JSON.stringify(manifest)
    );
    const r = readInstallManifest(tmp);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.reindex_state).toBe("failed");
    }
  });

  it("rejects non-object root (top-level array, string, number, null)", () => {
    mkdirSync(path.join(tmp, ".lodestone"), { recursive: true });
    writeFileSync(path.join(tmp, ".lodestone", "install-manifest.json"), "[]");
    const r = readInstallManifest(tmp);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("schema-mismatch");
  });
});

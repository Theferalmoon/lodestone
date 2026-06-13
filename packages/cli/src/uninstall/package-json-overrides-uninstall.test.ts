// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  NPM_OVERRIDE_PROVENANCE_REL,
  type PackageJsonOverrideProvenance,
  removePackageJsonOverrides,
} from "./package-json-overrides-uninstall.js";

describe("removePackageJsonOverrides", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "lodestone-pkg-json-uninst-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function writePackageJson(obj: unknown): void {
    writeFileSync(path.join(tmp, "package.json"), `${JSON.stringify(obj, null, 2)}\n`);
  }

  function writeProvenance(provenance: PackageJsonOverrideProvenance): void {
    const target = path.join(tmp, NPM_OVERRIDE_PROVENANCE_REL);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(provenance, null, 2)}\n`);
  }

  function provenance(
    over: Partial<PackageJsonOverrideProvenance> = {}
  ): PackageJsonOverrideProvenance {
    return {
      schema_version: 1,
      package_json_existed: true,
      package_json_path: path.join(tmp, "package.json"),
      overrides: {
        had_key: false,
        was_plain_object: false,
      },
      pins: {
        protobufjs: {
          installed: "7.5.8",
          had_previous: false,
        },
      },
      ...over,
    };
  }

  it("returns missing-provenance instead of guessing ownership", () => {
    writePackageJson({ overrides: { protobufjs: "7.5.8" } });
    const r = removePackageJsonOverrides(tmp);
    expect(r.action).toBe("missing-provenance");
    expect(JSON.parse(readFileSync(path.join(tmp, "package.json"), "utf8"))).toEqual({
      overrides: { protobufjs: "7.5.8" },
    });
  });

  it("removes a Lodestone-added override and deletes the now-empty overrides object", () => {
    writePackageJson({
      type: "module",
      overrides: { protobufjs: "7.5.8" },
    });
    writeProvenance(provenance());

    const r = removePackageJsonOverrides(tmp);

    expect(r.action).toBe("restored");
    expect(JSON.parse(readFileSync(path.join(tmp, "package.json"), "utf8"))).toEqual({
      type: "module",
    });
  });

  it("restores a previous friend-owned override value", () => {
    writePackageJson({
      overrides: { protobufjs: "7.5.8", other: "1.0.0" },
    });
    writeProvenance(
      provenance({
        overrides: {
          had_key: true,
          was_plain_object: true,
          previous_value: { protobufjs: "7.5.7", other: "1.0.0" },
        },
        pins: {
          protobufjs: {
            installed: "7.5.8",
            had_previous: true,
            previous: "7.5.7",
          },
        },
      })
    );

    const r = removePackageJsonOverrides(tmp);

    expect(r.action).toBe("restored");
    expect(JSON.parse(readFileSync(path.join(tmp, "package.json"), "utf8"))).toEqual({
      overrides: { protobufjs: "7.5.7", other: "1.0.0" },
    });
  });

  it("deletes package.json when the installer created it and no friend fields remain", () => {
    writePackageJson({
      private: true,
      overrides: { protobufjs: "7.5.8" },
    });
    writeProvenance(provenance({ package_json_existed: false }));

    const r = removePackageJsonOverrides(tmp);

    expect(r.action).toBe("removed-file");
    expect(existsSync(path.join(tmp, "package.json"))).toBe(false);
  });

  it("preserves package.json created by installer when friend fields were added", () => {
    writePackageJson({
      private: true,
      scripts: { start: "node index.js" },
      overrides: { protobufjs: "7.5.8" },
    });
    writeProvenance(provenance({ package_json_existed: false }));

    const r = removePackageJsonOverrides(tmp);

    expect(r.action).toBe("restored");
    expect(JSON.parse(readFileSync(path.join(tmp, "package.json"), "utf8"))).toEqual({
      private: true,
      scripts: { start: "node index.js" },
    });
  });

  it("does not remove an override whose current value changed after install", () => {
    writePackageJson({ overrides: { protobufjs: "8.0.0" } });
    writeProvenance(provenance());

    const r = removePackageJsonOverrides(tmp);

    expect(r.action).toBe("noop");
    expect(r.detail).toContain("protobufjs");
    expect(JSON.parse(readFileSync(path.join(tmp, "package.json"), "utf8"))).toEqual({
      overrides: { protobufjs: "8.0.0" },
    });
  });

  it("dry-run reports restoration without mutating package.json", () => {
    writePackageJson({ overrides: { protobufjs: "7.5.8" } });
    writeProvenance(provenance());
    const before = readFileSync(path.join(tmp, "package.json"));

    const r = removePackageJsonOverrides(tmp, { dryRun: true });

    expect(r.action).toBe("restored");
    expect(Buffer.compare(before, readFileSync(path.join(tmp, "package.json")))).toBe(0);
  });

  it("returns unparseable and leaves package.json untouched on malformed JSON", () => {
    writeFileSync(path.join(tmp, "package.json"), "{not-json");
    writeProvenance(provenance());

    const r = removePackageJsonOverrides(tmp);

    expect(r.action).toBe("unparseable");
    expect(readFileSync(path.join(tmp, "package.json"), "utf8")).toBe("{not-json");
  });
});

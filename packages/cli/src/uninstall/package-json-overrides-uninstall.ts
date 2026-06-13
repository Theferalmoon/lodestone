// SPDX-License-Identifier: Apache-2.0
// Reverses the package.json npm override pins written by the public friend
// installer. This is provenance-based because package.json is friend-owned:
// if the installer did not record the previous override state, uninstall must
// not guess that a matching advisory pin belongs to Lodestone.
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../install/atomic.js";

export const NPM_OVERRIDE_PROVENANCE_REL = path.join(
  ".lodestone",
  "npm-overrides-provenance.json"
);

export interface PackageJsonOverrideProvenance {
  schema_version: 1;
  package_json_existed: boolean;
  package_json_path: string;
  overrides: {
    had_key: boolean;
    was_plain_object: boolean;
    previous_value?: unknown;
  };
  pins: Record<
    string,
    {
      installed: string;
      had_previous: boolean;
      previous?: unknown;
    }
  >;
}

export type RemovePackageJsonOverridesResult =
  | { action: "restored"; path: string; detail?: string }
  | { action: "removed-file"; path: string }
  | { action: "noop"; path: string; detail?: string }
  | { action: "missing-provenance"; path: string }
  | { action: "unparseable"; path: string; detail: string };

interface JsonObject {
  [key: string]: unknown;
}

interface RestorePlan {
  changed: boolean;
  removeFile: boolean;
  nextPackageJson: JsonObject;
  restoredPins: string[];
  skippedPins: string[];
}

export function removePackageJsonOverrides(
  repoRoot: string,
  opts: { dryRun?: boolean } = {}
): RemovePackageJsonOverridesResult {
  const packageJsonPath = path.join(repoRoot, "package.json");
  const provenancePath = path.join(repoRoot, NPM_OVERRIDE_PROVENANCE_REL);

  if (!existsSync(provenancePath)) {
    return { action: "missing-provenance", path: packageJsonPath };
  }

  let provenance: PackageJsonOverrideProvenance;
  try {
    provenance = readProvenance(provenancePath);
  } catch (err) {
    return {
      action: "unparseable",
      path: provenancePath,
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  if (!existsSync(packageJsonPath)) {
    return { action: "noop", path: packageJsonPath, detail: "package.json not present" };
  }

  // Do not write to provenance.package_json_path. It is recorded for audit
  // evidence only; restore always targets the current repo root so a tampered
  // provenance file cannot redirect package.json writes outside the project.
  let packageJson: JsonObject;
  try {
    packageJson = readJsonObject(packageJsonPath, "package.json");
  } catch (err) {
    return {
      action: "unparseable",
      path: packageJsonPath,
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const plan = planRestore(packageJson, provenance);
  if (!plan.changed) {
    return {
      action: "noop",
      path: packageJsonPath,
      detail:
        plan.skippedPins.length > 0
          ? `current override values differ for: ${plan.skippedPins.join(", ")}`
          : "no Lodestone override pins found",
    };
  }

  if (opts.dryRun === true) {
    return plan.removeFile
      ? { action: "removed-file", path: packageJsonPath }
      : {
          action: "restored",
          path: packageJsonPath,
          detail: formatRestoredPins(plan),
        };
  }

  if (plan.removeFile) {
    rmSync(packageJsonPath, { force: true });
    return { action: "removed-file", path: packageJsonPath };
  }

  writeFileAtomic(packageJsonPath, `${JSON.stringify(plan.nextPackageJson, null, 2)}\n`);
  return {
    action: "restored",
    path: packageJsonPath,
    detail: formatRestoredPins(plan),
  };
}

function planRestore(
  packageJson: JsonObject,
  provenance: PackageJsonOverrideProvenance
): RestorePlan {
  const nextPackageJson = cloneJsonObject(packageJson);
  const overrides = nextPackageJson.overrides;
  if (!isPlainObject(overrides)) {
    return {
      changed: false,
      removeFile: false,
      nextPackageJson,
      restoredPins: [],
      skippedPins: Object.keys(provenance.pins),
    };
  }

  const restoredPins: string[] = [];
  const skippedPins: string[] = [];
  for (const [name, pin] of Object.entries(provenance.pins)) {
    if (overrides[name] !== pin.installed) {
      skippedPins.push(name);
      continue;
    }
    if (pin.had_previous) {
      overrides[name] = pin.previous;
    } else {
      delete overrides[name];
    }
    restoredPins.push(name);
  }

  if (restoredPins.length === 0) {
    return {
      changed: false,
      removeFile: false,
      nextPackageJson,
      restoredPins,
      skippedPins,
    };
  }

  if (Object.keys(overrides).length === 0) {
    if (!provenance.overrides.had_key) {
      delete nextPackageJson.overrides;
    } else if (!provenance.overrides.was_plain_object) {
      nextPackageJson.overrides = provenance.overrides.previous_value;
    }
  }

  const removeFile =
    !provenance.package_json_existed &&
    Object.keys(nextPackageJson).length === 1 &&
    nextPackageJson.private === true;

  return {
    changed: true,
    removeFile,
    nextPackageJson,
    restoredPins,
    skippedPins,
  };
}

function readProvenance(pathname: string): PackageJsonOverrideProvenance {
  const parsed = readJsonObject(pathname, "npm override provenance");
  if (parsed.schema_version !== 1) {
    throw new Error("unsupported npm override provenance schema");
  }
  if (typeof parsed.package_json_existed !== "boolean") {
    throw new Error("package_json_existed must be boolean");
  }
  if (typeof parsed.package_json_path !== "string") {
    throw new Error("package_json_path must be string");
  }
  if (!isPlainObject(parsed.overrides)) {
    throw new Error("overrides provenance must be an object");
  }
  if (typeof parsed.overrides.had_key !== "boolean") {
    throw new Error("overrides.had_key must be boolean");
  }
  if (typeof parsed.overrides.was_plain_object !== "boolean") {
    throw new Error("overrides.was_plain_object must be boolean");
  }
  if (!isPlainObject(parsed.pins)) {
    throw new Error("pins must be an object");
  }
  for (const [name, pin] of Object.entries(parsed.pins)) {
    if (!isPlainObject(pin)) throw new Error(`pin ${name} must be an object`);
    if (typeof pin.installed !== "string") {
      throw new Error(`pin ${name}.installed must be string`);
    }
    if (typeof pin.had_previous !== "boolean") {
      throw new Error(`pin ${name}.had_previous must be boolean`);
    }
  }
  return parsed as unknown as PackageJsonOverrideProvenance;
}

function readJsonObject(pathname: string, label: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(pathname, "utf8"));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`failed to parse ${label}: ${detail}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed;
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneJsonObject(value: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function formatRestoredPins(plan: RestorePlan): string {
  const restored = `restored ${plan.restoredPins.join(", ")}`;
  return plan.skippedPins.length > 0
    ? `${restored}; skipped changed values for ${plan.skippedPins.join(", ")}`
    : restored;
}

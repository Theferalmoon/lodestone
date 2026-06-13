#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Lodestone friend installer — pulls the package tarballs from a GitHub
# Release and installs them into your project's node_modules, then runs
# `lodestone init` for you.
#
# One-line usage:
#
#   # Lite (default — Snowflake 384d embedder; ~16 MB to download)
#   curl -sSfL https://lodestone.cmndi.ai/install | bash
#
#   # Full (Nomic 768d embedder; ~89 MB to download — advanced setups)
#   curl -sSfL https://lodestone.cmndi.ai/install | LODESTONE_PROFILE=full bash
#
#   # Also wire project-local Codex MCP config (opt-in)
#   curl -sSfL https://lodestone.cmndi.ai/install | LODESTONE_CLIENT=codex bash
#
#   # Pin a specific version, if this installer carries checksums for it
#   curl -sSfL https://lodestone.cmndi.ai/install | LODESTONE_VERSION=v0.1.11 LODESTONE_PROFILE=lite bash
#
#   # Strict npm advisory mode for existing projects with old/stale lockfiles
#   curl -sSfL https://lodestone.cmndi.ai/install | LODESTONE_STRICT_NPM_OVERRIDES=1 bash
#
# (lodestone.cmndi.ai/install redirects to a fixed installer ref. If this
# script is moved forward for a new Lodestone release, update the checksum
# table below before publishing the installer ref.)
#
# What it does:
#   1. Resolves the version (env LODESTONE_VERSION, default v0.1.11).
#   2. Resolves the profile (env LODESTONE_PROFILE, default "lite").
#   3. Downloads the tarballs from the GH release into a temp dir.
#   4. Verifies each tarball's SHA-256 before installation.
#   5. Installs them into ./node_modules using `npm install ./*.tgz`.
#   6. Adds npm root overrides for patched transitive packages that npm
#      consumers do not inherit from the monorepo's pnpm overrides. By default
#      this is the narrow protobufjs pin; strict mode also pins the broader
#      advisory-sensitive transitive set from the release workspace.
#   7. Runs the lodestone bin's `init` against the current dir, optionally
#      with `--client codex` when LODESTONE_CLIENT=codex is set.
#   8. Points the friend at the installed docs path when the package carries it.
#
# Disk footprint (lite profile verified e2e 2026-06-13 against v0.1.11 on Node 22;
# full profile sizes from the published GitHub release assets):
#   • Tarball download (what your bandwidth pays for):
#         ~16 MB (lite)   /   ~89 MB (full)
#   • ./node_modules total after install, with transitive deps:
#         ~1 GB in either profile (tree-sitter parsers, better-sqlite3,
#         onnxruntime-node, ~240 other packages)
#   The bulk on disk is the npm dep tree, not Lodestone itself.
#
# Requires: curl, node ≥20, npm. Cleans up its temp dir on success or failure.
#
# Privacy: lodestone bundles its embedder weights inside the
# `@lodestone/ingest` tarball. After this install, no model fetch is needed
# at runtime and Lodestone does not upload your source code. Install-time
# network use includes the verified Lodestone tarballs from GitHub and npm's
# normal dependency resolution for the packages named by those tarballs.
#
# Access: github.com/Theferalmoon/lodestone is currently a public repository,
# so no auth is required to fetch this script or the release tarballs. This
# installer uses anonymous downloads by default. Maintainers can opt into
# private-release auth with GH_TOKEN=<pat> or LODESTONE_USE_GH_AUTH=1.
#
# Compliance summary (friend-facing): Apache-2.0 license; bundled embedders
# are US-origin Snowflake / Nomic English-family models vetted against the
# CMNDI supply-chain policy; no runtime model fetch.

set -euo pipefail

REPO="Theferalmoon/lodestone"
LODESTONE_VERSION="${LODESTONE_VERSION:-v0.1.11}"
LODESTONE_PROFILE="${LODESTONE_PROFILE:-lite}"
LODESTONE_CLIENT="${LODESTONE_CLIENT:-}"
LODESTONE_STRICT_NPM_OVERRIDES="${LODESTONE_STRICT_NPM_OVERRIDES:-0}"
WORK_DIR="$(mktemp -d -t lodestone-install-XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT

log() { printf '[lodestone-install] %s\n' "$*" >&2; }
fail() { printf '[lodestone-install] ERROR: %s\n' "$*" >&2; exit 1; }

validate_positive_int() {
  local name="$1"
  local value="$2"
  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    fail "$name must be a positive integer, got '$value'"
  fi
}

sha256_file() {
  local path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$path" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$path" | awk '{print $1}'
  else
    fail "sha256sum or shasum is required for release verification"
  fi
}

expected_sha256() {
  local tag="$1"
  local file="$2"
  case "$tag:$file" in
    v0.1.11:lodestone-cli-0.1.11.tgz) printf '%s\n' "063ebdb929535ff6bdbf088095327ae64e2a174d8616bca539281e5a2f1f8900" ;;
    v0.1.11:lodestone-shared-0.1.11.tgz) printf '%s\n' "0f967c5ebd5cbcf95cc9161bd8155a88da66f467504e89fb7f2da577a44b095d" ;;
    v0.1.11:lodestone-mcp-server-0.1.11.tgz) printf '%s\n' "620b763a3caf3538843352f4ed16639dddd34ba593d6255cd7de43962e63ef34" ;;
    v0.1.11:lodestone-ingest-0.1.11-lite.tgz) printf '%s\n' "c9722564e33bb9a752c725255ebcc3f5cd37facc37a7bb8ddc1d811ac2321566" ;;
    v0.1.11:lodestone-ingest-0.1.11-full.tgz) printf '%s\n' "c4e408fb58cb785773f484658860d204d7dfacf5bb47c9dcfe08d9f0497b4c31" ;;
    v0.1.10:lodestone-cli-0.1.10.tgz) printf '%s\n' "b26874681115a6f8fd0905ee769f01617ce563ff92659d1b51dff00562c6f3aa" ;;
    v0.1.10:lodestone-shared-0.1.10.tgz) printf '%s\n' "329bc70d838ec255574c4ef0d62c45071ca17cb131dd7933d886aacf35d73d86" ;;
    v0.1.10:lodestone-mcp-server-0.1.10.tgz) printf '%s\n' "f836aad7cb81b2227674549f2266602ee94dd8ced101efa7af928ae897b6bc68" ;;
    v0.1.10:lodestone-ingest-0.1.10-lite.tgz) printf '%s\n' "56563370722116a830c0d1f428fb9e4031603b0fa01d00fd4672d7dece90cc98" ;;
    v0.1.10:lodestone-ingest-0.1.10-full.tgz) printf '%s\n' "d261b152612b49a0e64910ad43867c52b553144a247ad26483eb918e407adb49" ;;
    v0.1.9:lodestone-cli-0.1.9.tgz) printf '%s\n' "0be58236e0df565200fb4bed5b3cf0bd1b8fbe6e8454c29b6aedc40ea0200968" ;;
    v0.1.9:lodestone-shared-0.1.9.tgz) printf '%s\n' "3ddf62205d0d6d8917321c73199b2a3bb7604054874685993d173250e0387064" ;;
    v0.1.9:lodestone-mcp-server-0.1.9.tgz) printf '%s\n' "f1b6853f633243b72972d3c2a96cc9d52799ea23e93b80283bb396cd45c9dfce" ;;
    v0.1.9:lodestone-ingest-0.1.9-lite.tgz) printf '%s\n' "e3c460b916fbab92f4a379f33d11c42567d90a82d80f6799bdd05ae843505f9f" ;;
    v0.1.9:lodestone-ingest-0.1.9-full.tgz) printf '%s\n' "68958ff0a12c787802860f62f614c596ca803e1b1f461b0266ef19338be4c1da" ;;
    v0.1.8:lodestone-cli-0.1.8.tgz) printf '%s\n' "e740dc310478e7baf8934d48fed29c37d7d32ada55befd4d48b30fe19ae0a698" ;;
    v0.1.8:lodestone-shared-0.1.8.tgz) printf '%s\n' "28aaac5d55185076997a419f256cff3067a7caa83bd98a3178cfdff9ed527f75" ;;
    v0.1.8:lodestone-mcp-server-0.1.8.tgz) printf '%s\n' "c6fa5a237776efe07fde031af78a17e91407e9c9818d7c5ff85e08b9cc9f69fe" ;;
    v0.1.8:lodestone-ingest-0.1.8-lite.tgz) printf '%s\n' "a59088d8d255d9d64fa15cd9127d58255a8e6ccc8cee648a25ef19294b713f3d" ;;
    v0.1.8:lodestone-ingest-0.1.8-full.tgz) printf '%s\n' "3acb258ddf8b414bd9f282279432fc3f9279896f97b0855b1906cbe3b441a77c" ;;
    v0.1.7:lodestone-cli-0.1.7.tgz) printf '%s\n' "3e9fee2ccc5678baca15e492f17a8994b6300b20f65a14ab528cf4c7c887c9a8" ;;
    v0.1.7:lodestone-shared-0.1.7.tgz) printf '%s\n' "1fcdd55fc0313dbf672f7ec5160f305ae8948355a3005d8f17e1057c1b8aafcb" ;;
    v0.1.7:lodestone-mcp-server-0.1.7.tgz) printf '%s\n' "db7cb4d0bb7f6e741b986e2ab1ceef98d6138317eb1b71908597d59bf96dca45" ;;
    v0.1.7:lodestone-ingest-0.1.7-lite.tgz) printf '%s\n' "8b362528a7b218840dac7eb430cdeae65e426f3448dc01a86b413aac78a0c442" ;;
    v0.1.7:lodestone-ingest-0.1.7-full.tgz) printf '%s\n' "6fcba618a3aaf319a140a732df794c414d10fcb3dba882ff57dca4817070f99f" ;;
    v0.1.6:lodestone-cli-0.1.6.tgz) printf '%s\n' "1af67869d56c483bf70700c25cfb6dbbcb7fe00c7a5df8a21383e4924beb3171" ;;
    v0.1.6:lodestone-shared-0.1.6.tgz) printf '%s\n' "61b22b2d4485cdaf316aaa6aaf3070862875f7a90a69278272fb20cb5c7e0f0c" ;;
    v0.1.6:lodestone-mcp-server-0.1.6.tgz) printf '%s\n' "244f18ca1e0bb82d22f4dc43d760783bc77bcb805fd559cb755de28071606813" ;;
    v0.1.6:lodestone-ingest-0.1.6-lite.tgz) printf '%s\n' "a19c231b3c33252fdf9412ded65f17983609f71fdba8e17994c2925fb1ab669a" ;;
    v0.1.6:lodestone-ingest-0.1.6-full.tgz) printf '%s\n' "d5fca413eb49f67143e4fadfe9ad39cb3df6058868e49d38fadd66e8e867c53a" ;;
    v0.1.5:lodestone-cli-0.1.5.tgz) printf '%s\n' "22c05536b2265f51c334e13413416fe6aeb753cf10b7736930f0c203db56d2e1" ;;
    v0.1.5:lodestone-shared-0.1.5.tgz) printf '%s\n' "51d79614cf2dd0e11c92090604dfdb0e461540eaac5a1c0d645dd2ac70cadf24" ;;
    v0.1.5:lodestone-mcp-server-0.1.5.tgz) printf '%s\n' "9f718ab1649efb7ae02bcd02ed37e4bc3cc822b75587bc452192147314cc8ae8" ;;
    v0.1.5:lodestone-ingest-0.1.5-lite.tgz) printf '%s\n' "60a3c5d9f81c9071a423c66848dc7468b280fc3fc4c134fd34496cfced2a3dca" ;;
    v0.1.5:lodestone-ingest-0.1.5-full.tgz) printf '%s\n' "fafc8197d0a0bfa3812e0fc8b79c9fc7ad3c156d73a3f1f3b2e0623eed7126ba" ;;
    *) return 1 ;;
  esac
}

check_download() {
  local path="$1"
  local file="$2"
  local tag="$3"
  local expected actual

  if ! expected="$(expected_sha256 "$tag" "$file")"; then
    fail "no embedded checksum for $tag/$file; use a supported LODESTONE_VERSION or update the installer checksum table"
  fi

  actual="$(sha256_file "$path")"
  if [[ "$actual" != "$expected" ]]; then
    log "  checksum mismatch for $file: expected $expected, got $actual"
    return 1
  fi
  log "  verified $file sha256=$actual"
}

verify_download() {
  local path="$1"
  local file="$2"
  local tag="$3"

  check_download "$path" "$file" "$tag" || fail "checksum verification failed for $file"
}

download_public_asset() {
  local url="$1"
  local out="$2"
  local label="$3"
  local tag="$4"
  local retries="${LODESTONE_DOWNLOAD_RETRIES:-4}"
  local retry_delay="${LODESTONE_DOWNLOAD_RETRY_DELAY:-3}"
  local max_time="${LODESTONE_DOWNLOAD_MAX_TIME:-900}"
  local attempt
  local failure="download failed"

  validate_positive_int "LODESTONE_DOWNLOAD_RETRIES" "$retries"
  validate_positive_int "LODESTONE_DOWNLOAD_RETRY_DELAY" "$retry_delay"
  validate_positive_int "LODESTONE_DOWNLOAD_MAX_TIME" "$max_time"

  for ((attempt = 1; attempt <= retries; attempt++)); do
    rm -f "$out"
    if curl -sSfL --connect-timeout 30 --max-time "$max_time" -o "$out" "$url"; then
      if check_download "$out" "$label" "$tag"; then
        return 0
      fi
      failure="checksum verification failed"
    else
      failure="download failed"
    fi
    if [[ "$attempt" -lt "$retries" ]]; then
      log "  $failure for $label (attempt $attempt/$retries); retrying in ${retry_delay}s"
      sleep "$retry_delay"
    else
      log "  $failure for $label (attempt $attempt/$retries); giving up"
    fi
  done

  return 1
}

# ── Profile validation ──
case "$LODESTONE_PROFILE" in
  lite|full) ;;
  *) fail "invalid LODESTONE_PROFILE: '$LODESTONE_PROFILE' (allowed: lite | full)" ;;
esac
log "profile = $LODESTONE_PROFILE"

case "$LODESTONE_CLIENT" in
  ""|codex|all) ;;
  *) fail "invalid LODESTONE_CLIENT: '$LODESTONE_CLIENT' (allowed: codex | all)" ;;
esac
if [[ -n "$LODESTONE_CLIENT" ]]; then
  log "client adapter = $LODESTONE_CLIENT"
fi

case "$LODESTONE_STRICT_NPM_OVERRIDES" in
  0|false|FALSE|no|NO|"") ;;
  1|true|TRUE|yes|YES)
    log "strict npm overrides = enabled"
    ;;
  *) fail "invalid LODESTONE_STRICT_NPM_OVERRIDES: '$LODESTONE_STRICT_NPM_OVERRIDES' (allowed: 0 | 1 | true | false | yes | no)" ;;
esac

# ── Tooling check ──
command -v curl >/dev/null || fail "curl is required"
command -v node >/dev/null || fail "node is required (v20+)"
command -v npm  >/dev/null || fail "npm is required"

NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
[[ "$NODE_MAJOR" -ge 20 ]] || fail "node $NODE_MAJOR detected; lodestone requires v20+"

# ── Auth resolution ──
# Normal friend installs are anonymous public downloads. Maintainers can opt
# into private-release auth explicitly when testing non-public releases.
if [[ -n "${GH_TOKEN:-}" ]]; then
  log "using explicit GH_TOKEN"
elif [[ "${LODESTONE_USE_GH_AUTH:-}" == "1" ]] && command -v gh >/dev/null 2>&1; then
  GH_TOKEN="$(gh auth token 2>/dev/null || true)"
  [[ -n "$GH_TOKEN" ]] && log "using gh CLI token (gh auth login was run on this machine)"
fi
if [[ -z "${GH_TOKEN:-}" ]]; then
  log "using anonymous public GitHub downloads"
fi

# ── Resolve "latest" to an actual tag via the GitHub release API ──
if [[ "$LODESTONE_VERSION" == "latest" ]]; then
  fail "this pinned friend installer does not support LODESTONE_VERSION=latest; use LODESTONE_VERSION=v0.1.11 or fetch a newer installer"
else
  TAG="$LODESTONE_VERSION"
fi

VERSION_NUM="${TAG#v}"

# ── Tarball download list ──
# shared / mcp-server / cli are profile-agnostic; only ingest is profiled.
TARBALLS=(
  "lodestone-shared-$VERSION_NUM.tgz"
  "lodestone-mcp-server-$VERSION_NUM.tgz"
  "lodestone-cli-$VERSION_NUM.tgz"
  "lodestone-ingest-$VERSION_NUM-$LODESTONE_PROFILE.tgz"
)

log "downloading $TAG tarballs (profile=$LODESTONE_PROFILE) to $WORK_DIR ..."
for tgz in "${TARBALLS[@]}"; do
  URL="https://github.com/$REPO/releases/download/$TAG/$tgz"
  log "  pull $tgz"
  if [[ -n "${GH_TOKEN:-}" ]]; then
    # GitHub release-asset downloads need the API URL + Accept: application/octet-stream
    # to honor auth on private repos. The /releases/download/ path requires unauth or
    # public, but the /releases/assets/<id> API path takes the token.
    # Simpler and safer: require the gh CLI for authenticated private-release
    # downloads instead of pretending bearer auth works on /releases/download/.
    if command -v gh >/dev/null 2>&1; then
      gh release download "$TAG" --repo "$REPO" --pattern "$tgz" --dir "$WORK_DIR" \
        || fail "gh release download failed: $tgz"
    else
      fail "authenticated private-release downloads require the gh CLI; install gh or unset GH_TOKEN for public anonymous downloads"
    fi
  else
    download_public_asset "$URL" "$WORK_DIR/$tgz" "$tgz" "$TAG" \
      || fail "anonymous download failed (private repo? set GH_TOKEN or run 'gh auth login'): $URL"
    continue
  fi
  verify_download "$WORK_DIR/$tgz" "$tgz" "$TAG"
done

# ── Rename the profiled ingest to the canonical name npm expects ──
mv "$WORK_DIR/lodestone-ingest-$VERSION_NUM-$LODESTONE_PROFILE.tgz" \
   "$WORK_DIR/lodestone-ingest-$VERSION_NUM.tgz"

log "installing into $(pwd)/node_modules ..."
log "ensuring Lodestone npm overrides for advisory-clean consumer installs ..."
node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const packageJsonPath = "package.json";
let existed = fs.existsSync(packageJsonPath);
let data = {};

if (existed) {
  try {
    data = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  } catch (error) {
    console.error(`[lodestone-install] cannot parse ${packageJsonPath}: ${error.message}`);
    process.exit(1);
  }
} else {
  data = { private: true };
}

const strict = /^(1|true|yes)$/i.test(process.env.LODESTONE_STRICT_NPM_OVERRIDES ?? "");
const pins = {
  protobufjs: "7.5.8"
};
if (strict) {
  Object.assign(pins, {
    "fast-uri": "3.1.2",
    hono: "4.12.21",
    "ip-address": "10.1.1",
    qs: "6.15.2"
  });
}

const hadOverridesKey = Object.prototype.hasOwnProperty.call(data, "overrides");
const previousOverridesValue = hadOverridesKey ? data.overrides : undefined;
const overridesWasPlainObject =
  previousOverridesValue !== null &&
  typeof previousOverridesValue === "object" &&
  !Array.isArray(previousOverridesValue);
const previousOverrides =
  overridesWasPlainObject ? previousOverridesValue : {};
const provenance = {
  schema_version: 1,
  package_json_existed: existed,
  package_json_path: path.resolve(packageJsonPath),
  overrides: {
    had_key: hadOverridesKey,
    was_plain_object: overridesWasPlainObject,
    ...(hadOverridesKey ? { previous_value: previousOverridesValue } : {})
  },
  pins: Object.fromEntries(
    Object.entries(pins).map(([name, version]) => [
      name,
      {
        installed: version,
        had_previous: Object.prototype.hasOwnProperty.call(previousOverrides, name),
        ...(Object.prototype.hasOwnProperty.call(previousOverrides, name)
          ? { previous: previousOverrides[name] }
          : {})
      }
    ])
  )
};
fs.mkdirSync(".lodestone", { recursive: true });
const provenancePath = path.join(".lodestone", "npm-overrides-provenance.json");
if (!fs.existsSync(provenancePath)) {
  fs.writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
} else {
  console.error(
    "[lodestone-install] preserving existing package.json override provenance"
  );
}

if (!data.overrides || typeof data.overrides !== "object" || Array.isArray(data.overrides)) {
  data.overrides = {};
}

let changed = !existed;
for (const [name, version] of Object.entries(pins)) {
  if (data.overrides[name] !== version) {
    data.overrides[name] = version;
    changed = true;
  }
}

if (changed) {
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(data, null, 2)}\n`);
  console.error(
    existed
      ? "[lodestone-install] updated package.json overrides for Lodestone npm audit posture"
      : "[lodestone-install] created package.json with Lodestone npm audit overrides"
  );
} else {
  console.error("[lodestone-install] package.json already has required Lodestone npm overrides");
}
console.error(
  strict
    ? "[lodestone-install] strict npm override mode: protobufjs, fast-uri, hono, ip-address, qs"
    : "[lodestone-install] default npm override mode: protobufjs only"
);
NODE

# Order matters: shared first (depended on by others), then ingest +
# mcp-server (cli depends on both), then cli last.
# npm root overrides are required because friend installs use npm in the
# target project; npm does not inherit the monorepo's pnpm overrides.
npm install --no-save \
  "$WORK_DIR/lodestone-shared-$VERSION_NUM.tgz" \
  "$WORK_DIR/lodestone-ingest-$VERSION_NUM.tgz" \
  "$WORK_DIR/lodestone-mcp-server-$VERSION_NUM.tgz" \
  "$WORK_DIR/lodestone-cli-$VERSION_NUM.tgz" \
  || fail "npm install failed"

INIT_ARGS=(init)
if [[ -n "$LODESTONE_CLIENT" ]]; then
  INIT_ARGS+=(--client "$LODESTONE_CLIENT")
fi

log "running 'lodestone ${INIT_ARGS[*]}' ..."
./node_modules/.bin/lodestone "${INIT_ARGS[@]}"

log ""
log "done. Lodestone $TAG ($LODESTONE_PROFILE profile) installed."
if [[ -d "./node_modules/@lodestone/cli/docs" ]]; then
  log "documentation installed at ./node_modules/@lodestone/cli/docs/"
  log "HTML copy, if packaged, is at ./node_modules/@lodestone/cli/docs/html/index.html"
fi
log "online docs: https://lodestone.cmndi.ai/docs/"
log "Open Claude Code (or any MCP-aware editor) here and ask:"
log "  > what are the main subsystems of this codebase?"

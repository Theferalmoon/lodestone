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
#   # Pin a specific version, if this installer carries checksums for it
#   curl -sSfL https://lodestone.cmndi.ai/install | LODESTONE_VERSION=v0.1.5 LODESTONE_PROFILE=lite bash
#
# (lodestone.cmndi.ai/install redirects to a fixed installer ref. If this
# script is moved forward for a new Lodestone release, update the checksum
# table below before publishing the installer ref.)
#
# What it does:
#   1. Resolves the version (env LODESTONE_VERSION, default v0.1.5).
#   2. Resolves the profile (env LODESTONE_PROFILE, default "lite").
#   3. Downloads the tarballs from the GH release into a temp dir.
#   4. Verifies each tarball's SHA-256 before installation.
#   5. Installs them into ./node_modules using `npm install ./*.tgz`.
#   6. Runs the lodestone bin's `init` against the current dir.
#   7. Points the friend at the installed docs path when the package carries it.
#
# Disk footprint (lite profile verified e2e 2026-06-08 against v0.1.5 on Node 22;
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
LODESTONE_VERSION="${LODESTONE_VERSION:-v0.1.5}"
LODESTONE_PROFILE="${LODESTONE_PROFILE:-lite}"
WORK_DIR="$(mktemp -d -t lodestone-install-XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT

log() { printf '[lodestone-install] %s\n' "$*" >&2; }
fail() { printf '[lodestone-install] ERROR: %s\n' "$*" >&2; exit 1; }

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
    v0.1.5:lodestone-cli-0.1.5.tgz) printf '%s\n' "22c05536b2265f51c334e13413416fe6aeb753cf10b7736930f0c203db56d2e1" ;;
    v0.1.5:lodestone-shared-0.1.5.tgz) printf '%s\n' "51d79614cf2dd0e11c92090604dfdb0e461540eaac5a1c0d645dd2ac70cadf24" ;;
    v0.1.5:lodestone-mcp-server-0.1.5.tgz) printf '%s\n' "9f718ab1649efb7ae02bcd02ed37e4bc3cc822b75587bc452192147314cc8ae8" ;;
    v0.1.5:lodestone-ingest-0.1.5-lite.tgz) printf '%s\n' "60a3c5d9f81c9071a423c66848dc7468b280fc3fc4c134fd34496cfced2a3dca" ;;
    v0.1.5:lodestone-ingest-0.1.5-full.tgz) printf '%s\n' "fafc8197d0a0bfa3812e0fc8b79c9fc7ad3c156d73a3f1f3b2e0623eed7126ba" ;;
    *) return 1 ;;
  esac
}

verify_download() {
  local path="$1"
  local file="$2"
  local tag="$3"
  local expected actual

  if ! expected="$(expected_sha256 "$tag" "$file")"; then
    fail "no embedded checksum for $tag/$file; use a supported LODESTONE_VERSION or update the installer checksum table"
  fi

  actual="$(sha256_file "$path")"
  if [[ "$actual" != "$expected" ]]; then
    fail "checksum mismatch for $file: expected $expected, got $actual"
  fi
  log "  verified $file sha256=$actual"
}

# ── Profile validation ──
case "$LODESTONE_PROFILE" in
  lite|full) ;;
  *) fail "invalid LODESTONE_PROFILE: '$LODESTONE_PROFILE' (allowed: lite | full)" ;;
esac
log "profile = $LODESTONE_PROFILE"

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
  fail "this pinned friend installer does not support LODESTONE_VERSION=latest; use LODESTONE_VERSION=v0.1.5 or fetch a newer installer"
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
    curl -sSfL -o "$WORK_DIR/$tgz" "$URL" \
      || fail "anonymous download failed (private repo? set GH_TOKEN or run 'gh auth login'): $URL"
  fi
  verify_download "$WORK_DIR/$tgz" "$tgz" "$TAG"
done

# ── Rename the profiled ingest to the canonical name npm expects ──
mv "$WORK_DIR/lodestone-ingest-$VERSION_NUM-$LODESTONE_PROFILE.tgz" \
   "$WORK_DIR/lodestone-ingest-$VERSION_NUM.tgz"

log "installing into $(pwd)/node_modules ..."
# Order matters: shared first (depended on by others), then ingest +
# mcp-server (cli depends on both), then cli last.
npm install --no-save \
  "$WORK_DIR/lodestone-shared-$VERSION_NUM.tgz" \
  "$WORK_DIR/lodestone-ingest-$VERSION_NUM.tgz" \
  "$WORK_DIR/lodestone-mcp-server-$VERSION_NUM.tgz" \
  "$WORK_DIR/lodestone-cli-$VERSION_NUM.tgz" \
  || fail "npm install failed"

log "running 'lodestone init' ..."
./node_modules/.bin/lodestone init

log ""
log "done. Lodestone $TAG ($LODESTONE_PROFILE profile) installed."
if [[ -d "./node_modules/@lodestone/cli/docs" ]]; then
  log "documentation installed at ./node_modules/@lodestone/cli/docs/"
  log "HTML copy, if packaged, is at ./node_modules/@lodestone/cli/docs/html/index.html"
fi
log "online docs: https://lodestone.cmndi.ai/docs/"
log "Open Claude Code (or any MCP-aware editor) here and ask:"
log "  > what are the main subsystems of this codebase?"

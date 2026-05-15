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
#   # Full (Nomic 768d embedder; ~178 MB to download — advanced setups)
#   curl -sSfL https://lodestone.cmndi.ai/install | LODESTONE_PROFILE=full bash
#
#   # Pin a specific version
#   curl -sSfL https://lodestone.cmndi.ai/install | LODESTONE_VERSION=v0.1.4 LODESTONE_PROFILE=lite bash
#
# (lodestone.cmndi.ai/install is a 302 redirect to the canonical script at
# raw.githubusercontent.com/Theferalmoon/lodestone/main/scripts/install-from-release.sh
# — if Cloudflare is down for any reason, use that raw-GitHub URL directly.)
#
# What it does:
#   1. Resolves the version (env LODESTONE_VERSION, or "latest").
#   2. Resolves the profile (env LODESTONE_PROFILE, default "lite").
#   3. Downloads the tarballs from the GH release into a temp dir.
#   4. Installs them into ./node_modules using `npm install ./*.tgz`.
#   5. Runs the lodestone bin's `init` against the current dir.
#
# Disk footprint (lite profile verified e2e 2026-05-15 against v0.1.4 on Node 22;
# full profile sizes from the published GitHub release assets):
#   • Tarball download (what your bandwidth pays for):
#         ~16 MB (lite)   /   ~178 MB (full)
#   • ./node_modules total after install, with transitive deps:
#         ~1 GB in either profile (tree-sitter parsers, better-sqlite3,
#         onnxruntime-node, ~240 other packages)
#   The bulk on disk is the npm dep tree, not Lodestone itself.
#
# Requires: curl, node ≥20, npm. Cleans up its temp dir on success or failure.
#
# Privacy: lodestone bundles its embedder weights inside the
# `@lodestone/ingest` tarball. After this install, no network call is
# needed at runtime. The single network use is THIS install pulling
# from github.com/Theferalmoon/lodestone (a public repo).
#
# Access: github.com/Theferalmoon/lodestone is currently a public
# repository, so no auth is required to fetch this script or the release
# tarballs. If the operator later flips the repo private for a specific
# release, this installer will fall back to `gh release download` when
# `gh auth login` has been run, or to an explicit `GH_TOKEN=<pat>` env
# var; see the asset-download block below.
#
# Compliance summary (friend-facing): Apache-2.0 license; bundled
# embedders are US-origin (NVIDIA / IBM / Snowflake / Nomic English
# family) and vetted against the CMNDI supply-chain policy; no runtime
# model fetch.

set -euo pipefail

REPO="Theferalmoon/lodestone"
LODESTONE_VERSION="${LODESTONE_VERSION:-latest}"
LODESTONE_PROFILE="${LODESTONE_PROFILE:-lite}"
WORK_DIR="$(mktemp -d -t lodestone-install-XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT

log() { printf '[lodestone-install] %s\n' "$*" >&2; }
fail() { printf '[lodestone-install] ERROR: %s\n' "$*" >&2; exit 1; }

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
# Prefer explicit GH_TOKEN; fall back to gh CLI's stored token if available.
if [[ -z "${GH_TOKEN:-}" ]] && command -v gh >/dev/null 2>&1; then
  GH_TOKEN="$(gh auth token 2>/dev/null || true)"
  [[ -n "$GH_TOKEN" ]] && log "using gh CLI token (gh auth login was run on this machine)"
fi
if [[ -z "${GH_TOKEN:-}" ]]; then
  log "WARN: no GH_TOKEN and no gh CLI auth — will try anonymous (only works if the repo is public)"
fi

GH_AUTH_HEADER=()
[[ -n "${GH_TOKEN:-}" ]] && GH_AUTH_HEADER=(-H "Authorization: Bearer $GH_TOKEN")

# ── Resolve "latest" to an actual tag via the GitHub release API ──
if [[ "$LODESTONE_VERSION" == "latest" ]]; then
  log "resolving latest release tag from github.com/$REPO ..."
  TAG=$(curl -sSfL "${GH_AUTH_HEADER[@]}" \
        -H "Accept: application/vnd.github+json" \
        "https://api.github.com/repos/$REPO/releases/latest" | \
        grep -oE '"tag_name":\s*"[^"]+"' | head -1 | cut -d'"' -f4)
  [[ -n "$TAG" ]] || fail "could not resolve latest release tag (auth issue or no releases yet — pass LODESTONE_VERSION=v0.x.y explicitly)"
  log "latest = $TAG"
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
    # Simpler: use the gh CLI if available to download.
    if command -v gh >/dev/null 2>&1; then
      gh release download "$TAG" --repo "$REPO" --pattern "$tgz" --dir "$WORK_DIR" \
        || fail "gh release download failed: $tgz"
    else
      curl -sSfL "${GH_AUTH_HEADER[@]}" -o "$WORK_DIR/$tgz" "$URL" \
        || fail "download failed: $URL (try installing gh CLI for proper private-repo asset auth)"
    fi
  else
    curl -sSfL -o "$WORK_DIR/$tgz" "$URL" \
      || fail "anonymous download failed (private repo? set GH_TOKEN or run 'gh auth login'): $URL"
  fi
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
log "Open Claude Code (or any MCP-aware editor) here and ask:"
log "  > what are the main subsystems of this codebase?"

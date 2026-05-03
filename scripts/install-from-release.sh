#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Lodestone friend installer — pulls the four package tarballs from a
# GitHub Release and installs them into your project's node_modules,
# then runs `lodestone init` for you.
#
# One-line usage (after operator has cut a release):
#   curl -sSfL https://raw.githubusercontent.com/Theferalmoon/lodestone/main/scripts/install-from-release.sh | bash
#
# Or with a specific version:
#   curl -sSfL https://raw.githubusercontent.com/Theferalmoon/lodestone/main/scripts/install-from-release.sh | LODESTONE_VERSION=v0.1.4 bash
#
# What it does:
#   1. Detects the version (env var LODESTONE_VERSION, or "latest").
#   2. Downloads the four .tgz tarballs from the GH release into a temp dir.
#   3. Installs them into ./node_modules using `npm install ./*.tgz`.
#   4. Runs the lodestone bin's `init` against the current dir.
#
# Requires: curl, node ≥20, npm. Cleans up its temp dir on success or failure.
#
# Privacy: lodestone bundles its embedder weights (Nomic) inside the
# `@lodestone/ingest` tarball. After this install, no network call is
# needed at runtime. The single network use is THIS install pulling
# from github.com/Theferalmoon/lodestone (which you already trust).
#
# Compliance: NIST 800-53 SA-12, CM-6, CM-7; SOC 2 CC6.6; CMNDI supply
# chain ban list — Apache-2.0 deps, US-origin embedder.

set -euo pipefail

REPO="Theferalmoon/lodestone"
PACKAGES=(
  "lodestone-shared"
  "lodestone-ingest"
  "lodestone-mcp-server"
  "lodestone-cli"
)
LODESTONE_VERSION="${LODESTONE_VERSION:-latest}"
WORK_DIR="$(mktemp -d -t lodestone-install-XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT

log() { printf '[lodestone-install] %s\n' "$*" >&2; }
fail() { printf '[lodestone-install] ERROR: %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null || fail "curl is required"
command -v node >/dev/null || fail "node is required (v20+)"
command -v npm  >/dev/null || fail "npm is required"

NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
[[ "$NODE_MAJOR" -ge 20 ]] || fail "node $NODE_MAJOR detected; lodestone requires v20+"

# Resolve "latest" to an actual tag via the GitHub release API.
if [[ "$LODESTONE_VERSION" == "latest" ]]; then
  log "resolving latest release tag from github.com/$REPO ..."
  TAG=$(curl -sSfL "https://api.github.com/repos/$REPO/releases/latest" | \
        grep -oE '"tag_name":\s*"[^"]+"' | head -1 | cut -d'"' -f4)
  [[ -n "$TAG" ]] || fail "could not resolve latest release tag (is the repo public to you, or do you need a GH token?)"
  log "latest = $TAG"
else
  TAG="$LODESTONE_VERSION"
fi

VERSION_NUM="${TAG#v}"

log "downloading $TAG tarballs to $WORK_DIR ..."
for pkg in "${PACKAGES[@]}"; do
  TGZ="$pkg-$VERSION_NUM.tgz"
  URL="https://github.com/$REPO/releases/download/$TAG/$TGZ"
  log "  pull $TGZ"
  curl -sSfL -o "$WORK_DIR/$TGZ" "$URL" || fail "download failed: $URL"
done

log "installing into $(pwd)/node_modules ..."
# Order matters: shared first (depended on by others), then ingest +
# mcp-server (cli depends on both), then cli last. npm resolves the
# tree from the file: specifiers we pass on the command line.
npm install --no-save \
  "$WORK_DIR/lodestone-shared-$VERSION_NUM.tgz" \
  "$WORK_DIR/lodestone-ingest-$VERSION_NUM.tgz" \
  "$WORK_DIR/lodestone-mcp-server-$VERSION_NUM.tgz" \
  "$WORK_DIR/lodestone-cli-$VERSION_NUM.tgz" \
  || fail "npm install failed"

log "running 'lodestone init' ..."
./node_modules/.bin/lodestone init

log "done. Open Claude Code (or any MCP-aware editor) here and ask:"
log "  > what are the main subsystems of this codebase?"

#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# pack-profile.sh — produce lodestone tarballs for a specific install profile.
#
# Lodestone ships two friend-facing profiles (tarball download sizes from
# the published v0.1.7 GitHub release assets):
#   * lite — Snowflake 384d embedder, ~16 MB tarball. For friends with
#            low-RAM laptops or limited bandwidth. Default for friend
#            distribution.
#   * full — Nomic 768d embedder, ~89 MB tarball. For operator + Ryan +
#            advanced setups that want the higher-quality embedder.
#
# Both profiles ship the same shared/cli/mcp-server tarballs; only the ingest
# tarball differs (which embedder dir is included under dist/models/).
#
# Usage:
#   scripts/pack-profile.sh <lite|full> [--out-dir /tmp/lodestone-release]
#
# Output: 4 tarballs in --out-dir suffixed with the profile:
#   lodestone-shared-<version>.tgz
#   lodestone-cli-<version>.tgz
#   lodestone-mcp-server-<version>.tgz
#   lodestone-ingest-<version>-<profile>.tgz   ← ONLY this one differs
#
# Internals: temporarily removes the OTHER profile's models/ subdir from
# packages/ingest/dist/models/ before npm pack, restores after. Idempotent
# (always restores, even on failure).
#
# Compliance:
#   NIST 800-53: SA-12, CM-6
#   CMNDI mandate: §00.5 supply-chain (uses already-bundled, gate-approved
#                  weights — does not download)

set -euo pipefail

PROFILE="${1:-}"
OUT_DIR="/tmp/lodestone-release"
[[ "${2:-}" == "--out-dir" ]] && OUT_DIR="${3:?--out-dir requires a value}"

case "$PROFILE" in
  lite|full) ;;
  *) echo "usage: $0 <lite|full> [--out-dir <dir>]" >&2; exit 64 ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INGEST_DIST="$REPO_ROOT/packages/ingest/dist/models"
mkdir -p "$OUT_DIR"

if [[ "${LODESTONE_SKIP_DOCS_BUILD:-}" != "1" ]]; then
  echo "[pack-profile] refreshing friend docs before packing"
  DOCS_SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$(git -C "$REPO_ROOT" log -1 --format=%ct HEAD 2>/dev/null || date +%s)}"
  DOCS_BUILD_COMMIT="${LODESTONE_DOCS_BUILD_COMMIT:-$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)}"
  DOCS_BUILD_BRANCH="${LODESTONE_DOCS_BUILD_BRANCH:-$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)}"
  (
    cd "$REPO_ROOT"
    SOURCE_DATE_EPOCH="$DOCS_SOURCE_DATE_EPOCH" \
      LODESTONE_DOCS_BUILD_COMMIT="$DOCS_BUILD_COMMIT" \
      LODESTONE_DOCS_BUILD_BRANCH="$DOCS_BUILD_BRANCH" \
      pnpm docs:friend
  )
fi

if [[ "$PROFILE" == "lite" ]]; then
  KEEP="snowflake"
  REMOVE="nomic"
else
  KEEP="nomic"
  REMOVE="snowflake"
fi

# ── Verify both models are present (build artifact) ──
for d in nomic snowflake; do
  if [[ ! -d "$INGEST_DIST/$d" ]]; then
    echo "ERROR: $INGEST_DIST/$d missing. Run 'pnpm --filter @lodestone/ingest bundle-models && pnpm -r build' first." >&2
    exit 1
  fi
done

for stale in "$INGEST_DIST"/nomic/model_quantized.onnx "$INGEST_DIST"/snowflake/model_quantized.onnx; do
  if [[ -f "$stale" ]]; then
    echo "ERROR: stale top-level model file would be packaged: $stale" >&2
    echo "Run 'pnpm clean && pnpm -r build' to rebuild dist/models from source." >&2
    exit 1
  fi
done

echo "[pack-profile] profile=$PROFILE keep=$KEEP remove=$REMOVE out=$OUT_DIR"

# ── Temporarily move the not-wanted model dir out of dist ──
STASH_DIR="$(mktemp -d -t lodestone-pack-stash-XXXXXX)"
restore() {
  if [[ -d "$STASH_DIR/$REMOVE" ]]; then
    mv "$STASH_DIR/$REMOVE" "$INGEST_DIST/$REMOVE"
    echo "[pack-profile] restored $REMOVE to dist/models/"
  fi
  rm -rf "$STASH_DIR"
}
trap restore EXIT

mv "$INGEST_DIST/$REMOVE" "$STASH_DIR/$REMOVE"
echo "[pack-profile] stashed $REMOVE; packing with $KEEP only"

# ── Pack each package ──
for pkg in shared ingest mcp-server cli; do
  echo "[pack-profile]   pnpm pack $pkg"
  ( cd "$REPO_ROOT/packages/$pkg" && pnpm pack --pack-destination "$OUT_DIR" > /dev/null )
done

# ── Suffix the ingest tarball with the profile name ──
VERSION="$(node -e 'console.log(require("'"$REPO_ROOT"'/packages/ingest/package.json").version)')"
SRC_INGEST="$OUT_DIR/lodestone-ingest-$VERSION.tgz"
DEST_INGEST="$OUT_DIR/lodestone-ingest-$VERSION-$PROFILE.tgz"
mv "$SRC_INGEST" "$DEST_INGEST"

echo ""
echo "[pack-profile] done. Tarballs in $OUT_DIR:"
ls -lh "$OUT_DIR"/lodestone-*.tgz "$OUT_DIR"/lodestone-ingest-*-$PROFILE.tgz 2>/dev/null | awk '{print "  ", $9, "(" $5 ")"}'

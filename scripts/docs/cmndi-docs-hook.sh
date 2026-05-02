#!/usr/bin/env bash
# CMNDI-DOCS-MANDATE-001 — post-commit hook.
# - Regenerates docs/cmndi/index.html if any non-html file changed
# - Warns if docs/cmndi/0*.md hasn't been touched in N commits while source IS changing

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

CHANGED=$(git diff-tree --no-commit-id --name-only -r HEAD 2>/dev/null || true)
[ -z "$CHANGED" ] && exit 0

# Skip if commit only touched the generated HTML (avoid loop on the doc-refresh commit itself)
NON_HTML_CHANGED=$(echo "$CHANGED" | grep -v '^docs/cmndi/index\.html$' || true)
[ -z "$NON_HTML_CHANGED" ] && exit 0

# Regen if source MDs changed
MD_CHANGED=$(echo "$CHANGED" | grep -E '^docs/cmndi/0[1-6]-.*\.md$' || true)
if [ -n "$MD_CHANGED" ]; then
  if [ -x scripts/docs/cmndi-docs-build.py ]; then
    python3 scripts/docs/cmndi-docs-build.py >&2 || true
    echo "[cmndi-docs] regenerated docs/cmndi/index.html — stage and commit the refresh" >&2
  fi
fi

# Stale-docs warning: N=20
STALE_THRESHOLD=20
LAST_DOCS_COMMIT=$(git log -1 --format=%H -- docs/cmndi/0*.md 2>/dev/null || true)
if [ -n "$LAST_DOCS_COMMIT" ]; then
  COMMITS_SINCE=$(git rev-list --count "${LAST_DOCS_COMMIT}..HEAD" -- . 2>/dev/null || echo 0)
  if [ "$COMMITS_SINCE" -ge "$STALE_THRESHOLD" ]; then
    echo "[cmndi-docs] WARN: docs/cmndi/0*.md untouched for $COMMITS_SINCE commits — refresh per CMNDI-DOCS-MANDATE-001 §3" >&2
  fi
fi

exit 0

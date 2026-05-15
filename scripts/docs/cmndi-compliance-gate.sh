#!/usr/bin/env bash
# CMNDI-DOCS-MANDATE-001 §4b — pre-commit compliance gate.
# Default: WARN-by-default for most findings; HARD-FAIL only on banned-vendor introduction.
# Hotfix branches (hotfix/*, incident/*, revert/*) skip warn-tier entirely.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

STAGED=$(git diff --cached --name-only --diff-filter=ACMR)
[ -z "$STAGED" ] && exit 0

BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
HOTFIX=0
case "$BRANCH" in
  hotfix/*|incident/*|revert/*) HOTFIX=1 ;;
esac

note() { printf '[compliance-gate] %s\n' "$*" >&2; }
warn() { printf '[compliance-gate] WARN: %s\n' "$*" >&2; }
fail() { printf '[compliance-gate] FAIL: %s\n' "$*" >&2; }

# === HARD-FAIL: Banned-vendor scan in staged diff (always runs, no exemption) ===
BANNED_PATTERN='qwen|deepseek|baichuan|chatglm|internlm|yi-[0-9]|yandex|sber|minimax|skywork|moonshot|hunyuan'
BANNED_HITS=$(git diff --cached --no-color | grep -iE "^\+.*\b($BANNED_PATTERN)\b" | grep -viE 'HAYS-WAIVED|banned|forbidden|blocklist|deny' || true)
if [ -n "$BANNED_HITS" ]; then
  fail "banned-vendor reference introduced in staged diff:"
  echo "$BANNED_HITS" | head -10 >&2
  printf '\n[compliance-gate] CMNDI supply-chain mandate violation. Commit blocked.\n' >&2
  printf '[compliance-gate] If this is a documentation reference (e.g. listing what is banned), add a HAYS-WAIVED comment on the same line.\n' >&2
  exit 1
fi

# === Hotfix branches skip warn-tier ===
if [ "$HOTFIX" = "1" ]; then
  note "hotfix branch ($BRANCH) — warn-tier skipped, banned-vendor gate passed"
  exit 0
fi

# === WARN-tier: surface findings without blocking ===

# Mandate retrieval for staged areas (informational)
TOPICS=$(echo "$STAGED" | awk -F/ '{print $1"/"$2}' | sort -u | head -3)
if [ -x scripts/check-mandates.sh ]; then
  for topic in $TOPICS; do
    bash scripts/check-mandates.sh "$topic" >/dev/null 2>&1 || warn "check-mandates returned non-zero for $topic"
  done
fi

# Provenance gate for dep file changes (informational warning — actual gate is in pre-existing pre-commit)
DEP_FILES=$(echo "$STAGED" | grep -E '(package\.json|requirements\.txt|Pipfile|Cargo\.toml|go\.mod|pyproject\.toml|Dockerfile)$' || true)
if [ -n "$DEP_FILES" ] && [ ! -f .provenance-cleared ]; then
  warn "dependency files changed but no .provenance-cleared token; existing pre-commit will block. Run: clear-prov \"<reason>\""
fi

# Airgap verification for network-egress files
NET_FILES=$(echo "$STAGED" | grep -E '(curl|fetch|http|grpc|proxy|cloudflared|cloudflare)' || true)
if [ -n "$NET_FILES" ] && [ -x scripts/compliance/verify-airgap.sh ]; then
  bash scripts/compliance/verify-airgap.sh >/dev/null 2>&1 || warn "verify-airgap.sh returned non-zero — review network-egress changes"
fi

# rick-hays-bot health check (informational)
HAYS_HEALTH=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 http://localhost:3070/health 2>/dev/null || echo 000)
if [ "$HAYS_HEALTH" != "200" ]; then
  warn "rick-hays-bot not reachable on :3070 — relying on continuous-scan baseline"
fi

# HAYS-WAIVED inline-comment audit (informational)
WAIVED_COUNT=0
for f in $STAGED; do
  [ -f "$f" ] || continue
  c=$(grep -c "HAYS-WAIVED" "$f" 2>/dev/null) || c=0
  WAIVED_COUNT=$((WAIVED_COUNT + c))
done
if [ "$WAIVED_COUNT" -gt 0 ]; then
  note "$WAIVED_COUNT HAYS-WAIVED inline acknowledgement(s) in staged files — log will retain audit trail"
fi

note "warn-tier scan complete; commit allowed"
exit 0

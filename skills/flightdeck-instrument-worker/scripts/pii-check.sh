#!/usr/bin/env bash
# Flags likely PII in Flightdeck instrumentation added by a diff. A tripwire, not a proof.
# Usage: pii-check.sh [git-diff-range]   (default: origin/main...HEAD, plus uncommitted changes)
# Exit 1 when anything is flagged.
set -euo pipefail

RANGE=${1:-}
if [ -z "$RANGE" ]; then
  base=$(git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main)
  diff=$(git diff --no-color --no-ext-diff "$base" -U0 -- . ':(exclude)*.lock' ':(exclude)pnpm-lock.yaml')
else
  diff=$(git diff --no-color --no-ext-diff "$RANGE" -U0 -- . ':(exclude)*.lock' ':(exclude)pnpm-lock.yaml')
fi

# Added lines only, prefixed with their file, so hits are easy to locate.
added=$(awk '/^\+\+\+ b\//{file=substr($0,7)} /^\+[^+]/{print file": "substr($0,2)}' <<<"$diff")
if [ -z "$added" ]; then
  echo "pii-check: no added lines"
  exit 0
fi

# Lines that touch Flightdeck instrumentation.
fd=$(grep -E 'track(Event)?\(|identify(User)?\(|data-flightdeck|props:|flightdeck\(' <<<"$added" || true)

status=0
check() {
  local label=$1 pattern=$2 source=$3
  local hits
  hits=$(grep -Ei -- "$pattern" <<<"$source" || true)
  if [ -n "$hits" ]; then
    status=1
    echo "== $label"
    echo "$hits"
    echo
  fi
}

check "PII-like prop or attribute keys" \
  '(email|e_mail|first_?name|last_?name|full_?name|display_?name|username|phone|address|birth|dob|ssn|password|token|secret|api_?key|session_?id|student_?id|patient_?id|customer_?id|user_?id)["'"'"' ]*[:=]|data-flightdeck-(email|name|first-name|last-name|phone|address|user-id|student-id|token)' \
  "$fd"
check "free text or record fields passed as props" \
  '(\.|\b)(query|search|message|comment|title|body|description|filename|fileName|text)\b *[,})]' \
  "$fd"
check "dynamic event names (template literals or concatenation)" \
  '(track(Event)?\(|name: *|data-flightdeck=\{?)[^)]*(`[^`]*\$\{|["'"'"'] *\+)' \
  "$fd"
check "userId that looks like an email" \
  '(userId|identify(User)?\([^)]*)[^)]*\.email\b' \
  "$fd"
check "email literals anywhere in added lines" \
  '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' \
  "$fd"

if [ "$status" -eq 0 ]; then
  echo "pii-check: no hits in $(wc -l <<<"$fd" | tr -d ' ') instrumentation line(s)"
else
  echo "pii-check: fix each hit, or explain it in the PR description" >&2
fi
exit "$status"

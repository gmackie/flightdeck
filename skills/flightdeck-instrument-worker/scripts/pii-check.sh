#!/usr/bin/env bash
# Flags likely PII in Flightdeck instrumentation added by a diff. A tripwire, not a proof.
#
# Usage: pii-check.sh [git-diff-range]
#   no argument: everything since the merge base with the remote default branch (origin/HEAD),
#                including uncommitted and untracked files
#   a range:     only that range, e.g. main...HEAD
#
# Scope: every added line in a file that imports @flightdeckhq/*, contains data-flightdeck, or
# adds a track/identify call, so multi-line props objects are covered. Exit 1 on any hit.
set -euo pipefail

git rev-parse --git-dir >/dev/null 2>&1 || {
  echo "pii-check: not inside a git repository" >&2
  exit 2
}
cd "$(git rev-parse --show-toplevel)"

EXCLUDES=(':(exclude)*.lock' ':(exclude)pnpm-lock.yaml' ':(exclude)package-lock.json')
RANGE=${1:-}
if [ -n "$RANGE" ]; then
  diff=$(git diff --no-color --no-ext-diff -U0 "$RANGE" -- . "${EXCLUDES[@]}")
  untracked=""
else
  head_ref=$(git symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null || true)
  if [ -z "$head_ref" ]; then
    echo "pii-check: origin/HEAD is not set, so the default branch is unknown." >&2
    echo "  Run 'git remote set-head origin --auto', or pass a range: pii-check.sh main...HEAD" >&2
    exit 2
  fi
  base=$(git merge-base HEAD "$head_ref")
  # Against the working tree: committed, staged and unstaged changes.
  diff=$(git diff --no-color --no-ext-diff -U0 "$base" -- . "${EXCLUDES[@]}")
  untracked=$(git ls-files --others --exclude-standard)
fi

# "file<TAB>line" for every added line; untracked files count as entirely added.
added=$(awk '/^\+\+\+ /{file=substr($0,7); next} /^\+/{print file "\t" substr($0,2)}' <<<"$diff")
while IFS= read -r f; do
  [ -n "$f" ] && [ -f "$f" ] || continue
  grep -Iq . "$f" 2>/dev/null || continue # skip binary and empty files
  added+=$'\n'$(awk -v file="$f" '{print file "\t" $0}' "$f")
done <<<"$untracked"
added=$(grep -v '^$' <<<"$added" || true)

CALLS='track(Event)?\(|identify(User)?\(|flightdeck\(|data-flightdeck'
# Files in scope: they import the SDK or carry data-flightdeck, or the diff adds a call.
files=$(
  {
    cut -f1 <<<"$added" | sort -u | while IFS= read -r f; do
      if [ -f "$f" ] && grep -Eq '@flightdeckhq/|data-flightdeck' "$f"; then echo "$f"; fi
    done
    grep -E "$CALLS" <<<"$added" | cut -f1 || true
  } | sort -u
)
if [ -z "$files" ]; then
  echo "pii-check: no Flightdeck instrumentation in the diff; nothing to check"
  exit 0
fi
scope=$(awk -F'\t' 'NR==FNR{keep[$0]=1; next} keep[$1]{print $1 ": " substr($0, length($1)+2)}' \
  <(printf '%s\n' "$files") <(printf '%s\n' "$added"))

status=0
check() {
  local label=$1 pattern=$2 hits
  hits=$(grep -Ei -- "$pattern" <<<"$scope" || true)
  if [ -n "$hits" ]; then
    status=1
    printf '== %s\n%s\n\n' "$label" "$hits"
  fi
}

check "PII-like prop or attribute keys" \
  '(email|e_mail|first_?name|last_?name|full_?name|display_?name|username|phone|address|birth|dob|ssn|password|token|secret|api_?key|session_?id|student_?id|patient_?id|customer_?id|user_?id)["'"'"' ]*:|data-flightdeck-(email|name|first-name|last-name|phone|address|user-id|student-id|token)'
check "free text or record fields passed as props" \
  '[:=] *\{? *[A-Za-z_.]*\.(query|search|message|comment|title|body|description|filename|fileName|text)\b'
check "dynamic event names (template literals or concatenation)" \
  '(track(Event)?\(|name: *|data-flightdeck=\{?)[^)]*(`[^`]*\$\{|["'"'"'] *\+)'
check "userId that looks like an email" \
  '(userId|identify(User)?\()[^)]*\.email\b'
check "email literals" \
  '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'

count=$(wc -l <<<"$scope" | tr -d ' ')
nfiles=$(wc -l <<<"$files" | tr -d ' ')
if [ "$status" -eq 0 ]; then
  echo "pii-check: no hits in $count added line(s) across $nfiles instrumented file(s)"
else
  echo "pii-check: fix each hit, or explain it in the PR description" >&2
fi
exit "$status"

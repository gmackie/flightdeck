#!/usr/bin/env bash
# Phase 1 dev-account setup. Replaced by `npx create-flightdeck` in Phase 2.
#
# Creates (or skips, when already present) the R2 bucket + Basin Catalog, the fd_events and
# fd_sessions streams (Worker binding only, HTTP ingest disabled), their Basin Catalog sinks and
# pipelines, and the `flightdeck` D1 database. Then prints the IDs wrangler.jsonc needs.
#
# Usage: CATALOG_TOKEN_FILE=path/to/token scripts/provision-dev.sh [--write-config] [--migrate]
#   CATALOG_TOKEN_FILE  file holding an R2 API token with Admin Read & Write (needed only when a
#                       sink has to be created; the token is never printed)
#   BUCKET              R2 bucket with Basin Catalog enabled (default: flightdeck-demo-events)
#   --write-config      write the D1 id and stream ids into apps/flightdeck/wrangler.jsonc
#   --migrate           apply D1 migrations remotely (needs real ids in wrangler.jsonc)
set -euo pipefail

usage() { sed -n '2,13s/^# \{0,1\}//p' "$0"; }

WRITE_CONFIG=0
MIGRATE=0
for arg in "$@"; do
  case "$arg" in
    --write-config) WRITE_CONFIG=1 ;;
    --migrate) MIGRATE=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

BUCKET=${BUCKET:-flightdeck-demo-events}
NAMESPACE=flightdeck
D1_NAME=flightdeck
TABLES=(events sessions)

cd "$(dirname "$0")/../apps/flightdeck"

w() { pnpm exec wrangler "$@"; }

# `has_name NAME` reads a wrangler list from stdin and succeeds if an entry is named NAME.
# Matches both JSON (`"name": "x"`) and the inspect-style output `sinks list --json` prints.
has_name() { grep -Eq "[\"']?name[\"']?: *[\"']$1[\"']"; }

# `json_get EXPR` evaluates EXPR against the JSON document on stdin (bound to `j`).
json_get() {
  node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{const j=JSON.parse(s);const v=('"$1"');if(v==null)process.exit(1);console.log(v)})'
}

catalog_token() {
  : "${CATALOG_TOKEN_FILE:?set CATALOG_TOKEN_FILE to a file holding an R2 Admin Read & Write token}"
  if [[ ! -r "$CATALOG_TOKEN_FILE" ]]; then
    echo "CATALOG_TOKEN_FILE is not readable: $CATALOG_TOKEN_FILE" >&2
    exit 1
  fi
  cat "$CATALOG_TOKEN_FILE"
}

# 1. R2 bucket
if w r2 bucket list | grep -Eq "^name: +$BUCKET\$"; then
  echo "skip: R2 bucket $BUCKET exists"
else
  w r2 bucket create "$BUCKET"
fi

# 2. Basin Catalog on the bucket
if w r2 bucket catalog get "$BUCKET" 2>/dev/null | grep -Eiq '^Status: +active'; then
  echo "skip: Basin Catalog active on $BUCKET"
else
  w r2 bucket catalog enable "$BUCKET"
fi

# 3. Streams, sinks, pipelines (one of each per table)
streams=$(w basin pipelines streams list --json --per-page 100)
sinks=$(w basin pipelines sinks list --json --per-page 100)
pipelines=$(w basin pipelines list --json --per-page 100)

for t in "${TABLES[@]}"; do
  stream="fd_$t"
  sink="fd_${t}_sink"
  pipeline="fd_${t}_pipeline"

  if has_name "$stream" <<<"$streams"; then
    echo "skip: stream $stream exists"
  else
    w basin pipelines streams create "$stream" \
      --schema-file "pipelines/$t.schema.json" --http-enabled=false
  fi

  if has_name "$sink" <<<"$sinks"; then
    echo "skip: sink $sink exists"
  else
    w basin pipelines sinks create "$sink" --type r2-data-catalog --bucket "$BUCKET" \
      --namespace "$NAMESPACE" --table "$t" --roll-interval 60 \
      --catalog-token "$(catalog_token)"
  fi

  if has_name "$pipeline" <<<"$pipelines"; then
    echo "skip: pipeline $pipeline exists"
  else
    w basin pipelines create "$pipeline" --sql "INSERT INTO $sink SELECT * FROM $stream"
  fi
done

# 4. D1
d1_id() { w d1 list --json | json_get "j.find((d) => d.name === '$D1_NAME')?.uuid"; }
if D1_ID=$(d1_id); then
  echo "skip: D1 database $D1_NAME exists"
else
  w d1 create "$D1_NAME"
  D1_ID=$(d1_id)
fi

stream_id() { w basin pipelines streams get "$1" --json | json_get "j.id"; }
EVENTS_ID=$(stream_id fd_events)
SESSIONS_ID=$(stream_id fd_sessions)

echo
echo "D1 database_id ($D1_NAME):  $D1_ID"
echo "fd_events stream id:        $EVENTS_ID"
echo "fd_sessions stream id:      $SESSIONS_ID"

# 5. wrangler.jsonc (replaces the placeholders, or previously written ids)
if [[ $WRITE_CONFIG == 1 ]]; then
  # shellcheck disable=SC2016 # JS template literals, not shell expansions
  D1_ID=$D1_ID EVENTS_ID=$EVENTS_ID SESSIONS_ID=$SESSIONS_ID node -e '
    const fs = require("node:fs");
    const { D1_ID, EVENTS_ID, SESSIONS_ID } = process.env;
    let c = fs.readFileSync("wrangler.jsonc", "utf8");
    const swap = (re, value, what) => {
      if (!re.test(c)) throw new Error(`wrangler.jsonc: ${what} not found`);
      c = c.replace(re, (_m, head) => `${head}"${value}"`);
    };
    swap(/("database_name": "flightdeck",\s*"database_id": )"[^"]*"/, D1_ID, "D1 database_id");
    swap(/("binding": "EVENTS", "stream": )"[^"]*"/, EVENTS_ID, "EVENTS stream");
    swap(/("binding": "SESSIONS", "stream": )"[^"]*"/, SESSIONS_ID, "SESSIONS stream");
    fs.writeFileSync("wrangler.jsonc", c);
  '
  echo "wrote ids into apps/flightdeck/wrangler.jsonc"
else
  echo "Rerun with --write-config to write these into apps/flightdeck/wrangler.jsonc."
fi

# 6. Remote D1 migrations
if [[ $MIGRATE == 1 ]]; then
  if grep -q '"database_id": "<' wrangler.jsonc; then
    echo "wrangler.jsonc still has the D1 placeholder; rerun with --write-config --migrate" >&2
    exit 1
  fi
  w d1 migrations apply "$D1_NAME" --remote
else
  echo "Rerun with --migrate to apply D1 migrations remotely."
fi

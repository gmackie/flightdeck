#!/usr/bin/env bash
# Local end-to-end check: runs Flightdeck and the demo app as two `wrangler dev` processes
# (the service binding resolves through wrangler's local dev registry), sends one event
# through each path, and checks the AppDO snapshot. Pipelines writes are local simulations.
set -euo pipefail
cd "$(dirname "$0")/.."

FD_PORT=${FD_PORT:-8798}
APP_PORT=${APP_PORT:-8799}
FD=http://localhost:$FD_PORT
APP=http://localhost:$APP_PORT
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36"
# A leftover wrangler on either port would answer the health checks and mask a failed start.
port_in_use() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null || (exec 3<>"/dev/tcp/localhost/$1") 2>/dev/null; }
for port in "$FD_PORT" "$APP_PORT"; do
  if port_in_use "$port"; then
    echo "port $port is already in use; stop whatever is listening (lsof -i :$port) or set FD_PORT/APP_PORT" >&2
    exit 1
  fi
done

STATE=$(mktemp -d "${TMPDIR:-/tmp}/flightdeck-smoke.XXXXXX")
LOGS=$STATE/logs
mkdir -p "$LOGS"

PIDS=()
cleanup() {
  status=$?
  for pid in "${PIDS[@]}"; do
    # Each wrangler runs in its own process group; kill the group so workerd goes too.
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  # Grandchildren can outlive `wait`; give each group a few seconds, then force it.
  for pid in "${PIDS[@]}"; do
    for _ in $(seq 20); do
      kill -0 -- "-$pid" 2>/dev/null || break
      sleep 0.25
    done
    kill -KILL -- "-$pid" 2>/dev/null || true
  done
  if [ "$status" -ne 0 ]; then
    echo "smoke FAILED; wrangler logs:" >&2
    tail -n 40 "$LOGS"/*.log >&2 || true
  fi
  rm -rf "$STATE"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# Background jobs get their own process group, so cleanup can kill wrangler and workerd together.
set -m

pnpm --filter @flightdeckhq/demo-app --silent bundle:browser
(cd apps/flightdeck && pnpm exec wrangler d1 migrations apply flightdeck --local \
  --persist-to "$STATE/fd") >"$LOGS/migrate.log" 2>&1

(cd apps/flightdeck && exec pnpm exec wrangler dev --port "$FD_PORT" --inspector-port 0 \
  --persist-to "$STATE/fd" --var FLIGHTDECK_DEV:1) >"$LOGS/flightdeck.log" 2>&1 &
PIDS+=($!)
(cd examples/demo-app && exec pnpm exec wrangler dev --port "$APP_PORT" --inspector-port 0 \
  --persist-to "$STATE/demo") >"$LOGS/demo.log" 2>&1 &
PIDS+=($!)

for _ in $(seq 60); do
  if curl -sf "$FD/healthz" >/dev/null && curl -sf "$APP/" >/dev/null; then break; fi
  sleep 1
done
if ! { curl -sf "$FD/healthz" >/dev/null && curl -sf "$APP/" >/dev/null; }; then
  echo "workers did not start" >&2
  exit 1
fi

post() {
  curl -sf -X POST "$1" -H "Origin: $APP" -H "User-Agent: $UA" \
    -H "Content-Type: text/plain;charset=UTF-8" --data-binary "$2"
}

curl -sf -X POST "$FD/__dev/apps" -H "Content-Type: application/json" \
  -d '{"id":"app_demo","name":"Demo"}'
TS=$(($(date +%s) * 1000))
HOUR=$(date -u +%Y-%m-%dT%H)
SID=$(openssl rand -hex 16)

# Browser endpoint on the Worker (withFlightdeck).
post "$APP/_fd/e" "{\"events\":[
  {\"kind\":\"page\",\"name\":\"/\",\"path\":\"/\",\"ts\":$TS,\"sessionId\":\"$SID\"},
  {\"kind\":\"click\",\"name\":\"pricing.cta\",\"ts\":$((TS + 1)),\"sessionId\":\"$SID\"}]}"
# Endpoint served inside a Durable Object (handleFlightdeck).
post "$APP/room/_fd/e" "{\"events\":[
  {\"kind\":\"track\",\"name\":\"room.joined\",\"ts\":$((TS + 2)),\"sessionId\":\"$SID\"}]}"
# Server-side track() over the service binding.
curl -sf "$APP/api/checkout" >/dev/null

# Ingest commits at the Pipelines send and fans out to the DOs afterwards, so poll.
CHECK='
  const s = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const names = new Set(s.counters.map((c) => c.name));
  const missing = ["/", "pricing.cta", "room.joined", "checkout.completed"].filter((n) => !names.has(n));
  if (missing.length) { console.error("missing", missing.join(", ")); process.exit(1); }'
for attempt in $(seq 20); do
  SNAPSHOT=$(curl -sf "$FD/__dev/apps/app_demo/hours/$HOUR" || true)
  if node -e "$CHECK" <<<"$SNAPSHOT" 2>/dev/null; then break; fi
  if [ "$attempt" -eq 20 ]; then
    echo "$SNAPSHOT"
    node -e "$CHECK" <<<"$SNAPSHOT"
  fi
  sleep 0.5
done
node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(0, "utf8")), null, 2))' \
  <<<"$SNAPSHOT"
echo "smoke OK"

#!/usr/bin/env bash
# Packs the publishable packages the way `pnpm publish` would, installs the tarballs with npm
# into a scratch Worker project outside the workspace, typechecks a Worker and a browser file
# against them (TypeScript 5 and the repo's version), imports each library in Node, and runs
# the installed @flightdeckhq/create CLI. Catches missing dist files, broken exports and
# unrewritten workspace: dependencies before they reach npm.
set -euo pipefail
cd "$(dirname "$0")/.."

ROOT=$PWD
WORK=$(mktemp -d "${TMPDIR:-/tmp}/flightdeck-pack.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
TARBALLS=$WORK/tarballs
APP=$WORK/app
mkdir -p "$TARBALLS" "$APP/src"

# prepack builds each package's dist.
pnpm -r pack --pack-destination "$TARBALLS" >/dev/null
ls "$TARBALLS"

# Only dist, README, LICENSE and package.json may ship.
status=0
for tgz in "$TARBALLS"/*.tgz; do
  bad=$(tar -tzf "$tgz" | grep -Ev '^package/(dist/.+|README\.md|LICENSE|package\.json)$' || true)
  if [ -n "$bad" ]; then
    echo "$(basename "$tgz") ships unexpected files:" >&2
    echo "$bad" >&2
    status=1
  fi
  if tar -xOzf "$tgz" package/package.json | grep -q '"workspace:'; then
    echo "$(basename "$tgz") still has a workspace: dependency" >&2
    status=1
  fi
done
[ "$status" -eq 0 ] || exit 1

repo_version() { node -p "require('$ROOT/$1/package.json').devDependencies['$2']"; }
TS_VERSION=$(repo_version . typescript)
CF_TYPES_VERSION=$(repo_version packages/worker @cloudflare/workers-types)

cd "$APP"
cat >package.json <<'EOF'
{ "name": "flightdeck-pack-smoke", "private": true, "type": "module" }
EOF
npm install --no-audit --no-fund --loglevel=error \
  "$TARBALLS"/*.tgz \
  "typescript@$TS_VERSION" "ts5@npm:typescript@5" "@cloudflare/workers-types@$CF_TYPES_VERSION"

cat >src/worker.ts <<'EOF'
import { type FlightdeckOptions, flightdeck, withFlightdeck } from "@flightdeckhq/worker";

interface Env {
  FLIGHTDECK: Fetcher;
  FLIGHTDECK_USER_SALT: string;
}

const fdOptions = (env: Env): FlightdeckOptions => ({
  hashUserId: { salt: env.FLIGHTDECK_USER_SALT },
});

export default withFlightdeck<Env>(
  {
    async fetch(_request, env, ctx) {
      const result = flightdeck(env, fdOptions).track({ name: "checkout.completed" });
      ctx.waitUntil(result);
      return new Response("ok");
    },
  },
  fdOptions,
);
EOF
cat >src/browser.ts <<'EOF'
import { identify, init, track } from "@flightdeckhq/browser";

init({ redactProps: ["email"], beforeSend: (event) => event });
track("search.submitted", { results: 3 });
identify("user_1");
EOF
cat >src/lifecycle.ts <<'EOF'
import { executeInvestigation, type InvestigationRequest } from "@flightdeckhq/lifecycle-investigations";
import { createFakeAdapter, type QueryRegistry } from "@flightdeckhq/lifecycle-queries";
const registry: QueryRegistry = {
  appId: "synthetic", definitionId: "pipeline", metricVersion: "lifecycle.v1",
  availableFrom: "2026-01-01T00:00:00.000Z", maxWindowDays: 31, minSampleSize: 3,
  versions: { v1: { comparisonKey: "same", stages: { work: "work" }, checkpoints: {}, variants: { main: "main" } } },
  filterValues: { caseMix: ["standard"], cohortId: ["control"], definitionVersion: ["v1"], variantId: ["main"], outcome: ["open", "completed", "cancelled", "failed"] },
};
const request: InvestigationRequest = {
  recipe: "process-health", appId: registry.appId, definitionId: registry.definitionId,
  definitionVersions: ["v1"], metricVersion: "lifecycle.v1", asOf: "2026-02-01T00:00:00.000Z",
  window: { from: "2026-01-01T00:00:00.000Z", to: "2026-01-15T00:00:00.000Z" },
  cohort: { id: "control", caseMix: ["standard"] },
};
void executeInvestigation(request, {
  catalog: { revision: "r1", registry, stages: [{ id: "work", lane: "main" }], allowedGroupBy: [] },
  adapter: createFakeAdapter([], registry, request.asOf),
  authorize: () => ({ allowed: true, appId: registry.appId, scopeKey: "smoke-scope-r1" }),
});
EOF
cat >tsconfig.worker.json <<'EOF'
{
  "compilerOptions": {
    "target": "es2022",
    "module": "esnext",
    "moduleResolution": "bundler",
    "lib": ["es2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noEmit": true
  },
  "files": ["src/worker.ts", "src/lifecycle.ts"]
}
EOF
cat >tsconfig.browser.json <<'EOF'
{
  "compilerOptions": {
    "target": "es2022",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "lib": ["es2022", "dom"],
    "types": [],
    "strict": true,
    "noEmit": true
  },
  "files": ["src/browser.ts"]
}
EOF
for tsc in node_modules/typescript/bin/tsc node_modules/ts5/bin/tsc; do
  echo "typecheck with TypeScript $(node "$tsc" -v)"
  node "$tsc" -p tsconfig.worker.json
  node "$tsc" -p tsconfig.browser.json
done

# The libraries load as plain Node ESM (no bundler extension resolution).
node --input-type=module -e '
const schema = await import("@flightdeckhq/schema");
if (schema.normalizeRoute("/users/123") !== "/users/:id") throw new Error("schema: normalizeRoute");
const worker = await import("@flightdeckhq/worker");
for (const name of ["flightdeck", "handleFlightdeck", "withFlightdeck"])
  if (typeof worker[name] !== "function") throw new Error(`worker: ${name} missing`);
const browser = await import("@flightdeckhq/browser");
for (const name of ["init", "track", "identify"])
  if (typeof browser[name] !== "function") throw new Error(`browser: ${name} missing`);
const queries = await import("@flightdeckhq/lifecycle-queries");
const investigations = await import("@flightdeckhq/lifecycle-investigations");
const registry = queries.demoRegistry;
const request = {
  recipe: "process-health", appId: registry.appId, definitionId: registry.definitionId,
  definitionVersions: queries.demoQuery.definitionVersions, metricVersion: registry.metricVersion,
  asOf: queries.demoQuery.asOf, window: { from: queries.demoQuery.from, to: queries.demoQuery.to },
  cohort: queries.demoQuery.cohort,
};
const result = await investigations.executeInvestigation(request, {
  catalog: { revision: "smoke-r1", registry, stages: Object.values(registry.versions[request.definitionVersions[0]].stages).map(id => ({ id, lane: "main" })), allowedGroupBy: [] },
  adapter: queries.createFakeAdapter(queries.syntheticFacts(), registry, queries.demoWatermark),
  authorize: () => ({ allowed: true, appId: registry.appId, scopeKey: "smoke-scope-r1" }),
});
if (!result.pack.evidence.some(entry => entry.status === "ok")) throw new Error("investigations: no evidence");
if (investigations.parseEvidencePack(investigations.serializeEvidencePack(result.pack)).digest !== result.pack.digest)
  throw new Error("investigations: pack round-trip");
console.log("libraries import in Node; installed investigation executes");
'

node node_modules/@flightdeckhq/create/dist/cli.js --help | grep -q "@flightdeckhq/create apps add"
npx --no-install create-flightdeck --help | grep -q "@flightdeckhq/create apps add"
echo "@flightdeckhq/create --help works"
echo "pack smoke test passed"

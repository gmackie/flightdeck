# Inventory: repos x deployed Workers

All commands are read-only. Never edit the protected seeds under `/Volumes/dev` while inventorying.

## 1. Wrangler configs in local repos

```bash
for f in /Volumes/dev/*/wrangler.{toml,json,jsonc} /Volumes/dev/*/apps/*/wrangler.{toml,json,jsonc} \
         /Volumes/dev/*/packages/*/wrangler.{toml,json,jsonc}; do
  [ -f "$f" ] || continue
  name=$(perl -ne 'if (/^\s*"?name"?\s*[:=]\s*"([^"]+)"/) { print $1; exit }' "$f")
  echo -e "$(echo "$f" | cut -d/ -f4)\t$name\t$f"
done | sort
```

Also note stage files next to each config (`wrangler.staging.toml`, `wrangler.production.jsonc`, `env.*` blocks) and generated-config headers ("Generated from ... do not edit"); the per-repo agent needs them.

## 2. Workers deployed in the account

```bash
kvwn workers --json > /tmp/fd-workers.json         # every script in the account
kvwn registry sync && kvwn registry list --json > /tmp/fd-registry.json   # worker -> repo, config, ForgeGraph app/stage
forge app list --json > /tmp/fd-forge-apps.json    # ForgeGraph-managed apps
```

`kvwn registry` already joins Workers to local checkouts through ForgeGraph inventory and wrangler configs; use it as the base table and fill gaps from step 1.

## 3. Filter

Drop:

- duplicates of a target: `*-pr-*`, `*-onebox`, `*-router`, `*-beta`, `*-staging`, `*-preview` (they get the staging appId through the target's own config)
- examples, fixtures, benchmarks and test Workers (`/examples/`, `/tests/`, `/fixture/` in the config path; vinext's example apps)
- Workers with no recent invocations (`kvwn monitor --once --json --since 7d`) unless the owner says they matter
- Flightdeck itself (`flightdeck`, instrumented by Track A as `app_flightdeck`)
- infrastructure Workers that serve no product users (routers, cron probes, caches) unless asked

Keep one row per user-facing app Worker. A repo can have several (ForgeGraph: `forgegraf` web, `forgegraph-ci-control`, `forgegraph-git-gateway`).

## 4. Classify each row

| Column | How |
|---|---|
| framework | `@tanstack/react-start` in package.json -> TanStack Start; `@opennextjs/cloudflare` -> OpenNext; `hono` -> Hono; `assets` + `vite` without Start -> Vite SPA; else plain Worker |
| UI | has a client entry (`src/client.tsx`, `src/app/layout.tsx`, `src/main.tsx`, `index.html`) |
| sensitive | handles student/health/customer records (school-os/educateos, insure, hospital-fabric, fastbooks...): confirm with the owner when unsure |
| PR flow | `git -C /Volumes/dev/<repo> remote get-url origin`: `git.forgegraf.com` -> ForgeGraph, `github.com` -> GitHub |
| Kanbanger project | `kanbanger project list --all-teams --json`, matched to the repo |
| split | one agent, or backend + frontend agents (frontend in a separate package) |

## 5. Output

A table: repo, Worker(s), framework, UI, sensitive, PR flow, project, split, wave. Show it to the user and get the wave plan agreed before filing issues.

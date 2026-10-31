---
name: flightdeck-fleet-rollout
description: Orchestrates instrumenting many Cloudflare Worker apps with Flightdeck in parallel - inventories repos under /Volumes/dev with wrangler configs against the account's deployed Workers, files one Kanbanger issue per repo, dispatches per-repo agents in Worktrunk worktrees with the flightdeck-instrument-worker and flightdeck-instrument-frontend skills, runs waves of about five repos (sensitive apps last), follows each repo's own PR and deploy flow, verifies first events per appId, and reports a status table. Use when rolling Flightdeck analytics out across the fleet, across multiple repos or apps, or when coordinating FLIG-13 style fan-out work.
---

# Flightdeck fleet rollout

You coordinate; per-repo agents implement. Coordination issue: **FLIG-13** (Flightdeck project). Every repo also gets its own issue in its own Kanbanger project.

## 1. Inventory

Build the target list with [references/inventory.md](references/inventory.md): repos with wrangler configs, crossed with the Workers actually deployed in the account (`kvwn workers --json`, `kvwn registry list --json`). Skip `*-pr-*`, `*-onebox`, `*-router`, `*-beta`/`*-staging`/`*-preview` duplicates, examples, fixtures and test scripts. Mark one target app Worker per repo (plus extra Workers that serve users, if any) and classify it:

- framework: TanStack Start / OpenNext / Vite SPA / plain Worker / Hono
- has a browser UI (frontend skill applies) or is backend-only
- sensitive (student, health, customer records: school-os/educateos and similar)
- PR flow: ForgeGraph (`origin` on git.forgegraf.com) or GitHub (`origin` on github.com)

Show the inventory table to the user before filing issues.

## 2. Issues

For each target repo, follow the `kanbanger-workflow` skill: resolve the repo's own project, search for an existing Flightdeck issue, otherwise create one ("Instrument <app> with Flightdeck", body: repo, goal, scope, acceptance criteria, `Delivery target: production`, "Coordinated by FLIG-13"). Comment the new issue id on FLIG-13. Never put a repo's work in the Flightdeck project.

## 3. Dispatch

Before the first wave, check the SDKs are on npm: `npm view @flightdeckhq/worker version` and `npm view @flightdeckhq/browser version`. Until 0.1.0 is published they return 404; then stop, report on FLIG-14 (the npm release), and don't hand agents tarballs or vendored copies.

Register each wave's apps first (`npx @flightdeckhq/create apps add`, see `flightdeck-instrument-worker/references/registration.md`) and put the production and staging appIds in each brief. Per repo, one worktree (`worktrunk-worktrees` skill) and a brief from [references/agent-brief.md](references/agent-brief.md).

- **Default: one agent per repo**, running `flightdeck-instrument-worker` then `flightdeck-instrument-frontend` on the same branch. Single-package apps (TanStack Start, Next.js) put both SDKs in the same `package.json` and lockfile, the frontend needs the wrapped Worker to work at all, and the event names must agree; one PR avoids all three conflicts.
- **Two agents with separate branches** only when the frontend is a separate package with its own `package.json` (Vite SPA + API Worker, school-os `workshop-frontend` vs `workshop-backend`) or the UI is large enough that tagging is a job of its own. Ownership: backend agent owns the worker entry, wrangler config(s), server code and Durable Objects; frontend agent owns the client entry and components (plus `assets.run_worker_first`). Merge and deploy the backend PR first. Agree the event list (worker skill's report) before the frontend agent tags.

## 4. Waves

About five repos per wave. Wave 1 is the pilot (Kanbanger, ForgeGraph web + ci-control + git-gateway, Wafflehouse) unless FLIG-13 says it is done. Then most-trafficked apps first. Sensitive apps go in the last wave, each with `hashUserId` + `beforeSend` and a PR that lists every event and prop. Feed gaps you hit back into the skills (a PR to the Flightdeck repo) before the next wave. After each wave check Pipelines and Durable Object usage in the account.

## 5. PR and deploy flow (per repo, its own)

- ForgeGraph repos: `fg-pull-requests` / `fg-ship` skills (`forge` CLI); GitHub repos: `gh pr create`. Title and branch carry the repo issue id; link the PR with `kanbanger issue link <id> <url>`.
- Approve, merge and deploy only as that repo's own rules allow (green CI on the exact head; ForgeGraph auto-approve per the global instructions). Deploy staging first, verify, then production through the repo's normal pipeline.

## 6. Post-deploy verification

For each app: the first event is seen under the staging appId, then under the production appId (worker skill, `references/verification.md`: live view, or Basin SQL `min(received_at)` until the dashboard exists). The app stays healthy when Flightdeck errors: its health check passes and `/_fd/e` failing does not change other responses. Record evidence on the repo issue; close it only after production verification.

## 7. Status table

Keep it current in FLIG-13 and report it at the end of every wave:

| App | Repo | appId (prod / staging) | Issue | PR | Deploy ID | First event (UTC) | Notes |
|---|---|---|---|---|---|---|---|
| kanbanger | kanbanger | app_kanbanger / app_kanbanger_staging | KAN-123 | url | dep_... | 2026-11-02T14:03Z | |

Notes cover: skipped (why), blocked (by what), sensitive config applied, fail-open check result.

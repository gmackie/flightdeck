# Per-repo agent brief template

Fill every `<...>`. Send one brief per agent. For a two-agent split, send the backend brief and the frontend brief with the OWNERSHIP section adjusted, and tell the frontend agent the backend branch/PR.

---

You are instrumenting `<app>` in `<repo>` with Flightdeck analytics. Kanbanger issue: `<ISSUE-ID>` (project `<project>`), coordinated by FLIG-13. Do not touch any other repo.

**Skills to follow, in order:** `flightdeck-instrument-worker`, then `flightdeck-instrument-frontend` `<omit for backend-only or the backend agent of a split>`. Also `worktrunk-worktrees` and `kanbanger-workflow`.

**Worktree:** `cd /Volumes/dev/<repo> && wt switch --create <ISSUE-ID>-flightdeck`, then work only in `~/work/<repo>/<ISSUE-ID>-flightdeck`. Never edit `/Volumes/dev/<repo>`.

**Target Worker:** `<worker name>`, config `<path to wrangler config>`, stage configs `<env blocks / files / generator>`. Framework: `<TanStack Start | OpenNext | Vite SPA | Hono | plain Worker>`; recipe: `<references/recipe-*.md>`.

**SDKs:** install from npm (`@flightdeckhq/worker`, plus `@flightdeckhq/browser` for a UI).

**Registration:** production `<app_slug>`, staging `<app_slug_staging>` (already registered). If these are blank, register with `npx @flightdeckhq/create` per `flightdeck-instrument-worker/references/registration.md`. Staging, beta, previews and one-boxes bind the staging id.

**Ownership:** `<one agent: everything above>` / `<backend: worker entry, wrangler config(s), server code, Durable Objects>` / `<frontend: client entry, components, assets.run_worker_first only>`. Do not edit files outside your ownership; if you need a change there, report it.

**Events:** follow `flightdeck-instrument-worker/references/events.md`. Proposed domain events for this app: `<e.g. issue.created, project.created, member.invited>`; adjust to what the code actually does and list the final set in the PR.

**Sensitive:** `<no>` / `<yes: fill in fdOptions per the sensitive-apps section of events.md (FLIGHTDECK_USER_SALT secret in every stage, path-scrubbing beforeSend for routes <list>), browser redactProps <list>, no identify() for students; list every event and prop in the PR for review>`.

**Done when:**
- repo typecheck, lint and tests pass; `pii-check.sh` clean or every hit explained in the PR
- local two-process run shows the events; fail-open check passes (app unchanged with Flightdeck stopped)
- a test asserts the `/_fd/e` request (frontend)
- PR open through `<ForgeGraph: forge CLI / fg-pull-requests | GitHub: gh pr create>`, title and branch carry `<ISSUE-ID>`, linked with `kanbanger issue link <ISSUE-ID> <pr-url>`, issue moved to In Review
- `<deploy authorized: deploy staging via the repo's pipeline, verify first event under the staging appId; production after approval>` / `<do not deploy; the coordinator deploys>`

**Report back:** PR URL, head SHA, appIds, events added (name -> trigger, with props), tagged elements, verification output (local counters, fail-open result, first-event timestamp if deployed), anything blocked or deferred.

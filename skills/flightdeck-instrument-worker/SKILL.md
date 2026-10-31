---
name: flightdeck-instrument-worker
description: Instruments a Cloudflare Worker app with Flightdeck product analytics on the server side - registers the app, adds the FLIGHTDECK service binding (with props.appId) for every wrangler env or stage, wraps the fetch handler with withFlightdeck so the browser endpoint /_fd/e works, and adds track() at domain events and identify() after auth, in Workers and Durable Objects. Use when adding Flightdeck, analytics, product events, event tracking or @flightdeckhq/worker to a Worker, TanStack Start, OpenNext/Next.js, Hono or plain Worker app, or when wiring a FLIGHTDECK binding, withFlightdeck, flightdeck(env).track, hashUserId or beforeSend.
---

# Instrument a Worker with Flightdeck

App Workers talk to Flightdeck over a service binding (`FLIGHTDECK` -> Worker `flightdeck`, entrypoint `Ingest`). The binding's `props.appId` decides which app the events belong to. Analytics must never break the app: every call fails open.

Work in a worktree (`worktrunk-worktrees` skill). You own the worker entry, wrangler config(s), server code and Durable Objects. Leave the client entry and components to `flightdeck-instrument-frontend`.

## 1. Preconditions

- Find the deployable Worker: the `wrangler.*` whose `main` serves the app, and every env/stage config (top-level `env.*` blocks, `wrangler.<stage>.*` files, or generated configs). See [references/wrangler-bindings.md](references/wrangler-bindings.md).
- `npm view @flightdeckhq/worker version` must succeed. If it 404s, the SDKs are not published yet: stop and report to the coordinator (FLIG-13). Never vendor copies of the SDK.
- Install: `pnpm add @flightdeckhq/worker` in the Worker's package.

## 2. Register the app

```bash
create-flightdeck apps add <name> --stage production --json
create-flightdeck apps add <name> --stage staging --json
```

Each returns `{ app: { id, name, created_at }, binding: { binding: "FLIGHTDECK", service: "flightdeck", entrypoint: "Ingest", props: { appId } } }`. Ids are `app_<slug>` for production and `app_<slug>_<stage>` otherwise. Production gets its own appId; staging, beta, PR previews and one-boxes all bind the **staging** appId. Record both ids for the status table.

## 3. Add the binding to every env

Paste `binding` into `services` for each env (wrangler does not inherit `services` into `env.*` blocks). Exact toml/jsonc forms and generated-config handling: [references/wrangler-bindings.md](references/wrangler-bindings.md). Then run `wrangler types` (add `--strict-vars false` if the repo does) and commit the regenerated types.

## 4. Wrap the fetch handler

Wrap the outermost exported handler so `/_fd/e` is answered before routing, middleware, auth or tracing:

```ts
import { withFlightdeck } from "@flightdeckhq/worker";
export default withFlightdeck(handler, fdOptions);
```

`withFlightdeck` only touches `POST /_fd/e`; every other request, and `scheduled`/`queue`, pass through. A missing binding or a Flightdeck outage only fails `/_fd/e`. Backend-only Workers with no browser traffic can skip the wrapper and only use `track()`.

Recipes from real repos: [TanStack Start](references/recipe-tanstack-start.md), [OpenNext / Next.js](references/recipe-opennext.md), [plain Worker, Hono, Durable Objects](references/recipe-plain-worker.md).

## 5. Server events and identify

Put the fail-open helpers in one server module (e.g. `src/server/flightdeck.ts`) and call them at domain events, always under `waitUntil`:

```ts
import { type ClientEventInput, type FlightdeckOptions, flightdeck } from "@flightdeckhq/worker";

/** Shared by withFlightdeck (browser batches) and server calls. */
export const fdOptions: FlightdeckOptions = {};

type WaitUntil = (promise: Promise<unknown>) => void;
export type ServerEvent = Omit<ClientEventInput, "kind" | "ts"> & { ts?: number };

/** Analytics never throws into the request: errors are logged and dropped. */
function send(waitUntil: WaitUntil, call: () => Promise<unknown>): void {
  try {
    waitUntil(call().catch((err) => console.warn("flightdeck", err)));
  } catch (err) {
    console.warn("flightdeck", err);
  }
}

export const trackEvent = (env: object, waitUntil: WaitUntil, event: ServerEvent) =>
  send(waitUntil, () => flightdeck(env, fdOptions).track(event));

export const identifyUser = (env: object, waitUntil: WaitUntil, userId: string) =>
  send(waitUntil, () => flightdeck(env, fdOptions).identify({ userId }));
```

- Call sites: `trackEvent(env, (p) => ctx.waitUntil(p), { name: "issue.created", props: { source: "web" } })`, after the write succeeded. In a Durable Object pass `this.env` and `(p) => this.ctx.waitUntil(p)`; DOs see the same `FLIGHTDECK` binding.
- After sign-in completes: `identifyUser(env, waitUntil, user.id)`. `userId` is your internal stable user id (1-128 chars), never an email.
- Name events `object.verb` in past tense for server facts (`issue.created`, `deployment.verified`). Read [references/events.md](references/events.md) before adding any event: it has the shared taxonomy and the PII rules.
- Sensitive apps (student, health, customer records): `hashUserId` with a secret salt plus a path-scrubbing `beforeSend`, built per request as `fdOptions(env)` and served with `handleFlightdeck`. Follow the sensitive-apps section of events.md exactly.

## 6. Verify

1. Typecheck, lint and tests of the repo pass.
2. Run `scripts/pii-check.sh` from this skill against your diff; fix every hit or justify it in the PR.
3. Local two-process run and the fail-open check: [references/verification.md](references/verification.md).
4. After the staging deploy, confirm the first event under the staging appId (same file).

Report: repo, appIds, files changed, events added (name -> trigger), verification output.

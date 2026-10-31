---
name: flightdeck-instrument-worker
description: Instruments a Cloudflare Worker app with Flightdeck product analytics on the server side - registers the app, adds the FLIGHTDECK service binding (with props.appId) for every wrangler env or stage, wraps the fetch handler with withFlightdeck so the browser endpoint /_fd/e works, and adds track() at domain events and identify() after auth, in Workers and Durable Objects. Use when adding Flightdeck, analytics, product events, event tracking or @flightdeckhq/worker to a Worker, TanStack Start, OpenNext/Next.js, Hono or plain Worker app, or when wiring a FLIGHTDECK binding, withFlightdeck, flightdeck(env).track, hashUserId or beforeSend.
---

# Instrument a Worker with Flightdeck

App Workers talk to Flightdeck over a service binding (`FLIGHTDECK` -> Worker `flightdeck`, entrypoint `Ingest`). The binding's `props.appId` decides which app the events belong to. Analytics must never break the app: every call fails open.

Work in a worktree (`worktrunk-worktrees` skill). You own the worker entry, wrangler config(s), server code and Durable Objects. Leave the client entry and components to `flightdeck-instrument-frontend`.

## 1. Preconditions

- Find the deployable Worker: the `wrangler.*` whose `main` serves the app, and every env/stage config (top-level `env.*` blocks, `wrangler.<stage>.*` files, or generated configs). See [references/wrangler-bindings.md](references/wrangler-bindings.md).
- Install the SDK from npm in the Worker's package: `pnpm add @flightdeckhq/worker` (or the repo's package manager). It ships compiled ESM with types; it uses the repo's own Workers types, so nothing else is needed.
- Until 0.1.0 is published, `npm view @flightdeckhq/worker version` returns 404. If it does, stop and report on FLIG-14 (the npm release). Never vendor copies of the SDK or install it from a Flightdeck checkout.

## 2. Register the app

Use the appIds in your brief if the coordinator already registered the app. Otherwise run the registration CLI ([references/registration.md](references/registration.md) covers installing it, `FLIGHTDECK_URL` and Cloudflare Access auth):

```bash
npx create-flightdeck apps add <name> --stage production --json
npx create-flightdeck apps add <name> --stage staging --json
```

Each returns `{ app: { id, name, created_at }, binding: { binding: "FLIGHTDECK", service: "flightdeck", entrypoint: "Ingest", props: { appId } } }`. Ids are `app_<slug>` for production and `app_<slug>_<stage>` otherwise. Production gets its own appId; staging, beta, PR previews and one-boxes all bind the **staging** appId. Record both ids for the status table.

## 3. Add the binding to every env

Paste `binding` into `services` for each env (wrangler does not inherit `services` into `env.*` blocks). Exact toml/jsonc forms and generated-config handling: [references/wrangler-bindings.md](references/wrangler-bindings.md). Then run `wrangler types` (add `--strict-vars false` if the repo does) and commit the regenerated types.

## 4. The helper module

Every app gets the same module, e.g. `src/server/flightdeck.ts` (`src/lib/flightdeck.ts` in Next.js). `Env` is the repo's generated env type (`Env`, `Cloudflare.Env`, or `CloudflareEnv` with OpenNext).

```ts
import { type ClientEventInput, type FlightdeckOptions, flightdeck } from "@flightdeckhq/worker";

/**
 * Options for both withFlightdeck (browser batches) and server calls, built per request.
 * Sensitive apps fill this in (references/events.md); everyone else returns {}.
 */
export function fdOptions(_env: Env): FlightdeckOptions {
  return {};
}

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

export const trackEvent = (env: Env, waitUntil: WaitUntil, event: ServerEvent) =>
  send(waitUntil, () => flightdeck(env, fdOptions).track(event));

export const identifyUser = (env: Env, waitUntil: WaitUntil, userId: string) =>
  send(waitUntil, () => flightdeck(env, fdOptions).identify({ userId }));
```

Always pass `fdOptions` itself (the function) to `withFlightdeck`, `handleFlightdeck` and `flightdeck`; the SDK calls it with each request's `env`. If it throws, other requests are untouched, `/_fd/e` answers 500 and drops the batch, and server calls are logged and dropped.

## 5. Wrap the fetch handler and add events

Wrap the outermost exported handler, keeping every existing handler (`scheduled`, `queue`, DO re-exports), so `/_fd/e` is answered before routing, middleware, auth or tracing:

```ts
import { withFlightdeck } from "@flightdeckhq/worker";
import { fdOptions } from "./flightdeck";

export default withFlightdeck(handler, fdOptions);
```

`withFlightdeck` only touches `POST /_fd/e`; every other request, and `scheduled`/`queue`, pass through to `handler`. A missing binding or a Flightdeck outage only fails `/_fd/e`. Backend-only Workers with no browser traffic can skip the wrapper and only use `trackEvent`. Recipes from real repos: [TanStack Start](references/recipe-tanstack-start.md), [OpenNext / Next.js](references/recipe-opennext.md), [plain Worker, Hono, Durable Objects](references/recipe-plain-worker.md).

- Domain events: `trackEvent(env, (p) => ctx.waitUntil(p), { name: "issue.created", props: { source: "web" } })`, after the write succeeded. In a Durable Object pass `this.env` and `(p) => this.ctx.waitUntil(p)`; DOs see the same `FLIGHTDECK` binding.
- After sign-in completes: `identifyUser(env, waitUntil, user.id)`. `userId` is your internal stable user id (1-128 chars), never an email.
- Name events `object.verb` in past tense for server facts (`issue.created`, `deployment.verified`). Read [references/events.md](references/events.md) before adding any event: it has the shared taxonomy and the PII rules.
- Sensitive apps (student, health, customer records): fill in `fdOptions` exactly as the sensitive-apps section of events.md shows (secret salt with a guard, `hashUserId`, path-scrubbing `beforeSend`). Nothing else changes.

## 6. Verify

1. Typecheck, lint and tests of the repo pass.
2. Run `scripts/pii-check.sh` from this skill against your diff; fix every hit or justify it in the PR.
3. Local two-process run and the fail-open check: [references/verification.md](references/verification.md).
4. After the staging deploy, confirm the first event under the staging appId (same file).

Report: repo, appIds, files changed, events added (name -> trigger), verification output.

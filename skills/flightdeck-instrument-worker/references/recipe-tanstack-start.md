# Recipe: TanStack Start on Workers (custom server entry)

Applies to Kanbanger, Wafflehouse and every repo generated from create-gmacko-app: `wrangler.jsonc` `main` is `src/server/worker.ts`, the Cloudflare Vite plugin builds it, and TanStack Start's handler comes from `@tanstack/react-start/server-entry`.

## Wrap the entry

`makeWorker` style (Kanbanger `apps/web/src/server/worker.ts`, create-gmacko-app `apps/web/src/server/worker.ts`). Wrap the handler `makeWorker` returns; keep everything else as is:

```ts
import startEntry from "@tanstack/react-start/server-entry";
import { withFlightdeck } from "@flightdeckhq/worker";

import { fdOptions } from "./flightdeck";
import { makeWorker } from "./make-worker";
import "./runtime";

export default withFlightdeck(
  makeWorker<Cloudflare.Env>({
    fetch: (request) => startEntry.fetch(request),
  }),
  fdOptions,
);
```

Object-literal style (Wafflehouse `apps/web/src/server/worker.ts`, which exports `GameRoom`/`Lobby` and an effect-cf `fetch`). Keep the DO re-exports and the `satisfies`:

```ts
export default withFlightdeck(
  {
    fetch,
    scheduled: (controller) => traced(/* unchanged */),
  } satisfies ExportedHandler<Cloudflare.Env>,
  fdOptions,
);
```

`withFlightdeck` keeps `scheduled` (and any other handler) working, and it sits outside Sentry/effect-cf tracing, so `/_fd/e` posts don't create spans.

The helper module from SKILL.md step 4 (`fdOptions`, `trackEvent`, `identifyUser`) lives in `src/server/flightdeck.ts`; `Env` there is `Cloudflare.Env`.

## track() from route handlers and server functions

Start's `fetch` only receives the request, so handlers get `env` and `waitUntil` from `cloudflare:workers`. In create-gmacko-app derived repos only `src/server/runtime.ts` may import that module (lint rule); export a bound helper from there:

```ts
// src/server/runtime.ts (already imports these)
import { env, waitUntil } from "cloudflare:workers";
import { identifyUser, type ServerEvent, trackEvent } from "./flightdeck";

export const track = (event: ServerEvent) => trackEvent(env, waitUntil, event);
export const identify = (userId: string) => identifyUser(env, waitUntil, userId);
```

Then call `track({ name: "issue.created", props: { source: "web" } })` after the domain write succeeds (inside the Effect handler, after the repository call returns, not before). If the repo has a `Background` service wrapping `waitUntil`, you may use it instead, but keep the call fail-open.

## identify()

Call `identify(user.id)` where the session is established (better-auth `after` hook, or the sign-in handler), with the internal user id.

The browser also calls `identify(user.id)` once the client knows the user (frontend skill), which links that browser's anonymous id and session.

## Durable Objects (Wafflehouse GameRoom, Lobby)

DOs get the same bindings through their constructor, so `this.env.FLIGHTDECK` exists once the binding is in wrangler.jsonc:

```ts
import { trackEvent } from "../flightdeck";

// inside GameRoom, after a shift ends
trackEvent(this.env, (p) => this.ctx.waitUntil(p), {
  name: "shift.completed",
  props: { difficulty: state.difficulty, seats: humans },
});
```

Keep events coarse in hot paths: one event per game/shift/room lifecycle step, never per tick or per WebSocket message.

## Gotchas

- `/_fd/e` never reaches the Start router because `withFlightdeck` answers it first; no route file is needed.
- The Vite plugin serves built assets before the Worker. `/_fd/e` is not an asset, so it reaches the Worker; no `run_worker_first` change is needed unless `assets.not_found_handling` is `single-page-application` (then add it anyway, see the frontend skill).
- `vitest.workers.config.ts` suites that build the Worker need the binding in `wrangler.jsonc`; tests that call `trackEvent` with an env lacking `FLIGHTDECK` still pass because the helper fails open.

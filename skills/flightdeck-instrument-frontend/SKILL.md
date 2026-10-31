---
name: flightdeck-instrument-frontend
description: Instruments a web frontend with the Flightdeck browser SDK - installs @flightdeckhq/browser, calls init() once in the client entry (TanStack Start, Next.js app router, Vite SPA), makes sure /_fd/* reaches the app's Worker, tags primary CTAs, key forms and important views with data-flightdeck attributes following the shared naming guide, adds identify() after login, and verifies the /_fd/e beacon in a Playwright or happy-dom test. Use when adding Flightdeck, page views, click or form analytics, data-flightdeck attributes, beforeSend or redactProps to a React, TanStack Start, Next.js or Vite app running on Cloudflare Workers.
---

# Instrument a frontend with Flightdeck

The browser SDK posts batched events to `/_fd/e` on the page's own origin; the app's Worker (wrapped with `withFlightdeck`, see `flightdeck-instrument-worker`) forwards them to Flightdeck. No third-party requests, no CORS. Page views, including SPA navigations, are automatic. Clicks, form submits and views are captured from `data-flightdeck` attributes, so components need no imports.

You own the client entry and components. Do not edit the worker entry or wrangler config except `assets.run_worker_first` (step 3); if the backend agent has not wrapped the Worker yet, coordinate rather than doing it yourself.

## 1. Install

`pnpm add @flightdeckhq/browser` (or the repo's package manager) in the web app's package. It ships compiled ESM with types, so no `transpilePackages` or bundler changes are needed.

Until 0.1.0 is published, `npm view @flightdeckhq/browser version` returns 404. If it does, stop and report on FLIG-14 (the npm release). Never vendor copies of the SDK or install it from a Flightdeck checkout.

## 2. Init once in the client entry

```ts
import { init } from "@flightdeckhq/browser";

init();
```

`init()` is a no-op on the server and when called twice, so StrictMode and HMR are safe. Exact placement per framework: [references/recipes.md](references/recipes.md). Options (all optional): `endpoint` (default `/_fd/e`), `trackPages` (default true), `persistAnonymousId` (default true; false keeps the anonymous id per page load only), `maxBatch` (20), `flushIntervalMs` (5000), `redactProps`, `beforeSend`.

## 3. Make sure `/_fd/*` reaches the Worker

- Worker wrapped outermost with `withFlightdeck`: framework routers never see `/_fd/e`.
- Static assets served before the Worker: a POST to `/_fd/e` is not an asset, so it falls through, unless `assets.not_found_handling` is `"single-page-application"`. If the config has `assets` without `run_worker_first: true`, add `"/_fd/*"` to (or create) the `run_worker_first` array, in every env that restates `assets`.
- Check in the browser: DevTools network shows `POST /_fd/e` -> `204` (beacons appear as type `ping`/`beacon`).

## 4. Tag elements

```html
<button data-flightdeck="issue.create">New issue</button>
<form data-flightdeck="signup.form">...</form>
<section data-flightdeck="pricing.plans" data-flightdeck-view>...</section>
<a href="/pricing" data-flightdeck="nav.pricing" data-flightdeck-plan="pro">Pricing</a>
```

- `data-flightdeck="name"` on a non-form element: a `click` event (clicks on children count).
- On a `<form>`: a `submit` event (untagged clicks inside it are not counted).
- Plus `data-flightdeck-view`: a `view` event, once per element, when half of it is visible; no click event.
- `data-flightdeck-<key>="value"`: a prop (`data-flightdeck-plan-tier` -> `planTier`).

What to tag, how names relate to backend events, and what never to tag: [references/naming.md](references/naming.md). Read the PII rules in `flightdeck-instrument-worker/references/events.md` too.

## 5. Custom events and identify

```ts
import { identify, track } from "@flightdeckhq/browser";

track("editor.mode_changed", { mode: "markdown" });
identify(user.id); // once the client knows the signed-in user; internal id, never an email
```

Use `track()` only for client-only interactions that are not a click/submit/view (keyboard shortcuts, drag and drop, client-side state changes). Prefer attributes otherwise.

## 6. Sensitive apps

Configure `redactProps` and a path-scrubbing `beforeSend` in `init()`, exactly as in the sensitive-apps section of `flightdeck-instrument-worker/references/events.md`. `beforeSend` receives each event (`kind`, `name`, `path`, `props`, `userId`, ...) and returns it, a rewritten copy, or null to drop it; a throw drops the event. User id hashing happens in the app Worker (`hashUserId`), not in the browser.

## 7. Verify

1. Typecheck, lint, tests; `flightdeck-instrument-worker/scripts/pii-check.sh` on the diff.
2. Add a test that asserts the `/_fd/e` request carries the expected names: [references/testing.md](references/testing.md).
3. Local two-process run (worker skill, references/verification.md): click through and see each name in the counters.

Report: files changed, every tagged name with its element, verification output.

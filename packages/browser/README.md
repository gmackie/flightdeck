# @flightdeckhq/browser

Browser SDK for [Flightdeck](https://github.com/gmackie/flightdeck), self-hosted product analytics for Cloudflare. Under 3 KB gzipped. It batches events and posts them to `/_fd/e` on the page's own origin, which your Worker serves with [`@flightdeckhq/worker`](https://www.npmjs.com/package/@flightdeckhq/worker): no third-party requests, no CORS.

## Install

```bash
pnpm add @flightdeckhq/browser
```

## Use

Call `init()` once in your client entry. Page views, including SPA navigations, are recorded automatically.

```ts
import { identify, init, track } from "@flightdeckhq/browser";

init(); // a no-op on the server and when called twice

track("search.submitted", { results: 12 });
identify(user.id); // after sign-in; your internal id, never an email
```

Clicks, form submits and views are captured from attributes, so components need no imports:

```html
<button data-flightdeck="issue.create">New issue</button>
<section data-flightdeck="pricing.plans" data-flightdeck-view>...</section>
<a href="/pricing" data-flightdeck="nav.pricing" data-flightdeck-plan="pro">Pricing</a>
```

`init` options (all optional): `endpoint` (default `/_fd/e`), `trackPages`, `persistAnonymousId`, `maxBatch`, `flushIntervalMs`, `redactProps`, `beforeSend`.

## Docs

- [Instrumenting a frontend](https://github.com/gmackie/flightdeck/tree/main/skills/flightdeck-instrument-frontend/SKILL.md): framework recipes, tagging guide, testing the beacon
- [Agent skills](https://github.com/gmackie/flightdeck/tree/main/skills/README.md)

## License

MIT

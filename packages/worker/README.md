# @flightdeckhq/worker

Cloudflare Worker SDK for [Flightdeck](https://github.com/gmackie/flightdeck), self-hosted product analytics for Cloudflare. It serves the browser endpoint (`POST /_fd/e`) and sends server-side events to your Flightdeck over a service binding. Every call fails open: analytics never breaks the app.

## Install

```bash
pnpm add @flightdeckhq/worker
```

## Bind Flightdeck

Register the app with `npx create-flightdeck apps add <name> --json` and paste the returned binding into your wrangler config, once per env:

```jsonc
"services": [
  { "binding": "FLIGHTDECK", "service": "flightdeck", "entrypoint": "Ingest", "props": { "appId": "app_myapp" } }
]
```

## Use

```ts
import { flightdeck, withFlightdeck } from "@flightdeckhq/worker";

export default withFlightdeck<Env>({
  async fetch(request, env, ctx) {
    // Server-side event over the service binding.
    ctx.waitUntil(flightdeck(env).track({ name: "checkout.completed", props: { plan: "pro" } }));
    return new Response("ok");
  },
});
```

- `withFlightdeck(handler, options?)` answers `POST /_fd/e` for [`@flightdeckhq/browser`](https://www.npmjs.com/package/@flightdeckhq/browser) and passes everything else (and `scheduled`, `queue`, ...) to `handler`.
- `handleFlightdeck(request, env, options?)` does the same inside any `fetch` (Durable Objects, `WorkerEntrypoint` classes); it returns `null` for other requests.
- `flightdeck(env, options?)` returns the binding with `track(event)` and `identify({ userId })`.
- Options: `binding`, `path`, `allowedOrigins`, `maxBodyBytes`, and the privacy hooks `beforeSend` and `hashUserId`. Pass a function of `env` to build them per request.

The package ships ESM and type declarations. It uses your project's Workers types (`wrangler types` or `@cloudflare/workers-types`) and has no other runtime dependency than `@flightdeckhq/schema`.

## Docs

- [Instrumenting a Worker](https://github.com/gmackie/flightdeck/tree/main/skills/flightdeck-instrument-worker/SKILL.md): bindings per env, the helper module, events and PII rules
- [Agent skills](https://github.com/gmackie/flightdeck/tree/main/skills/README.md) and [operations docs](https://github.com/gmackie/flightdeck/tree/main/docs/operations)

## License

Apache-2.0

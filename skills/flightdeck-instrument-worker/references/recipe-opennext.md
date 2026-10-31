# Recipe: Next.js on OpenNext (custom worker wrapper)

Reference: ForgeGraph `apps/web/worker.mjs`, `open-next.config.ts`, `wrangler.toml` / `wrangler.staging.toml`.

OpenNext generates `.open-next/worker.js`. Apps that need extra handlers keep a hand-written `worker.mjs` that imports it and exports the real handler; wrangler (or a prebundle script) uploads that. If the app has no custom wrapper yet, add one rather than editing generated output:

```js
// worker.mjs ; point wrangler `main` at this file (or at the bundle built from it)
import { withFlightdeck } from "@flightdeckhq/worker";
import openNext from "./.open-next/worker.js";
import { fdOptions } from "./src/lib/flightdeck.ts";

export default withFlightdeck(openNext, fdOptions);
```

With an existing wrapper (ForgeGraph), keep every line and wrap the final object. ForgeGraph's default export spreads `budgeted` and overrides `fetch` and `scheduled`, so:

```js
const worker = {
  ...budgeted,
  async fetch(request, env, ctx) {
    /* unchanged: maintenance freeze, fast paths, page cache, budgeted.fetch */
  },
  async scheduled(_controller, env, ctx) {
    /* unchanged */
  },
};

export default withFlightdeck(worker, fdOptions);
```

Keep the DO re-exports (`export { RepositoryCoordinator } ...`) as they are. `fdOptions` is the helper module's function (SKILL.md step 4; `Env` is `CloudflareEnv`); a JS wrapper passes it unchanged, so sensitive-app options apply here too. Wrapping outermost means `/_fd/e` skips the maintenance freeze (it is not a data write), the page cache and the budget wrapper.

If the repo prebundles the wrapper (ForgeGraph: `scripts/bundle-worker.mjs`, `no_bundle = true`), rebuild with the repo's script (`pnpm build:worker`) and run its bundle tests; the new import must survive bundling.

## track() in route handlers and server actions

OpenNext exposes the request's bindings and context through `getCloudflareContext`:

```ts
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { trackEvent } from "@/lib/flightdeck";

export async function POST(request: Request) {
  const deployment = await verifyDeployment(request);
  const { env, ctx } = getCloudflareContext();
  trackEvent(env, (p) => ctx.waitUntil(p), {
    name: "deployment.verified",
    props: { stage: deployment.stage },
  });
  return Response.json(deployment);
}
```

Call it after the write succeeded. In server actions use the same pattern. Where the repo already passes `ctx` into a request-scoped helper (ForgeGraph `runWithCloudflareRequestContext`), reuse that instead of calling `getCloudflareContext` again.

## identify()

After better-auth (or the app's auth) establishes a session, call `identifyUser(env, (p) => ctx.waitUntil(p), user.id)` in the same handler.

## Gotchas

- `@flightdeckhq/*` packages ship TypeScript sources until Flightdeck publishes builds; Next must transpile the browser package (see the frontend skill: `transpilePackages`). The Worker wrapper is bundled by wrangler/esbuild, which handles `.ts`.
- Next middleware never sees `/_fd/e`, because the wrapper answers first; no matcher change is needed.
- Production traffic for ForgeGraph reaches `forgegraf` through `forgegraph-router`. Confirm the browser's `Origin` matches the URL the Worker sees; if not, set `allowedOrigins` in `fdOptions` (recipe-plain-worker.md).

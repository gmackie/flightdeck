# Client entry recipes

`init()` must run once, in the browser, as early as practical, so the first page view and early clicks are captured.

## TanStack Start (Kanbanger, Wafflehouse, create-gmacko-app derived repos)

The browser entry is `apps/web/src/client.tsx`. Call `init()` before hydrating:

```tsx
/// <reference types="vite/client" />
import { init } from "@flightdeckhq/browser";
import { StartClient } from "@tanstack/react-start/client";
import { StrictMode, startTransition } from "react";
import { hydrateRoot } from "react-dom/client";

init();

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <StartClient />
    </StrictMode>,
  );
});
```

Router navigations use `history.pushState`, which the SDK already follows; do not add a router subscription.

Identify: in the component or hook that loads the session on the client (often the root route's `beforeLoad`/loader result or an auth provider), call `identify(session.user.id)` when the user becomes known. `identify` sends one event each call, so guard it (e.g. a `useEffect` keyed on the user id).

## Next.js app router (OpenNext)

A client component rendered once from the root layout:

```tsx
// src/app/flightdeck.tsx
"use client";

import { init } from "@flightdeckhq/browser";
import { useEffect } from "react";

export function Flightdeck() {
  useEffect(() => {
    init();
  }, []);
  return null;
}
```

```tsx
// src/app/layout.tsx
import { Flightdeck } from "./flightdeck";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Flightdeck />
        {children}
      </body>
    </html>
  );
}
```

Until Flightdeck publishes compiled builds, the package ships TypeScript sources, so add it to `next.config`:

```ts
const nextConfig = { transpilePackages: ["@flightdeckhq/browser"] };
```

App router navigations use `history.pushState`/`replaceState`; page views are automatic. Server components can carry `data-flightdeck` attributes directly; they need no client boundary.

## Vite SPA (React or otherwise)

```ts
// src/main.tsx
import { init } from "@flightdeckhq/browser";

init();
// ...createRoot(document.getElementById("root")!).render(<App />);
```

Static-assets-first Workers (`assets` in wrangler config, Worker only for `/api/*`): add `/_fd/*` to `run_worker_first`:

```jsonc
"assets": {
  "directory": "./dist",
  "binding": "ASSETS",
  "not_found_handling": "single-page-application",
  "run_worker_first": ["/api/*", "/_fd/*"]
}
```

```toml
[assets]
directory = "./dist"
not_found_handling = "single-page-application"
run_worker_first = ["/api/*", "/_fd/*"]
```

Already `run_worker_first = true` (skillfleet, habitplay): nothing to add.

## Endpoint served by a Durable Object

When the page talks to a DO-routed path that serves the endpoint itself (`handleFlightdeck` with `path: "/room/_fd/e"`), pass the same path: `init({ endpoint: "/room/_fd/e" })`.

## Static HTML or non-bundled pages

Bundle the SDK once (`esbuild node_modules/@flightdeckhq/browser/src/index.ts --bundle --minify --format=esm --outfile=public/fd.js`) and load it as a module, as `examples/demo-app/public/index.html` does:

```html
<script type="module">
  import { init } from "/fd.js";
  init();
</script>
```

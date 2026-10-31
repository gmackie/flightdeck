# @flightdeckhq/schema

Shared event schema for [Flightdeck](https://github.com/gmackie/flightdeck), self-hosted product analytics for Cloudflare. It holds the [Valibot](https://valibot.dev) schemas and limits for event batches, the types of the `FLIGHTDECK` service binding, route normalization, and the user-agent parser. [`@flightdeckhq/worker`](https://www.npmjs.com/package/@flightdeckhq/worker) and [`@flightdeckhq/browser`](https://www.npmjs.com/package/@flightdeckhq/browser) depend on it; most apps never import it directly.

## Install

```bash
pnpm add @flightdeckhq/schema
```

## Use

```ts
import { ClientEvent, MAX_BATCH, normalizeRoute, type IngestRpc } from "@flightdeckhq/schema";
import * as v from "valibot";

const event = v.parse(ClientEvent, input); // throws on an invalid event
normalizeRoute("/users/123"); // "/users/:id"
```

## Docs

- [Design](https://github.com/gmackie/flightdeck/tree/main/docs/plans) and [operations docs](https://github.com/gmackie/flightdeck/tree/main/docs/operations)

## License

Apache-2.0

# Flightdeck

**Open-source, account-owned behavioral analytics and application intelligence on Cloudflare.**

Flightdeck gives existing Workers and Durable Objects a typed, private **service binding** for analytics. Those Workers authenticate their own users, handle their own browser event endpoints, and submit approved events through the Flightdeck core. No mandatory public Flightdeck collector is necessary.

[Separate-workspace deployment](docs/deploy-workspace.md) · [Agent MCP](docs/agents-mcp.md) · [Agent issue handoff](docs/agent-handoffs.md) · [Admin wizard & MCP](docs/admin-mcp.md) · [Process Twin](docs/digital-twin.md) · [Release gates](docs/release-gates.md) · [Installation guide](docs/installation.md) · [Service binding integration](docs/service-bindings.md) · [Architecture](docs/architecture.md) · [Source governance](docs/source-governance.md) · [Privacy](docs/privacy-and-retention.md) · [Console](docs/console.md) · [AI discovery](docs/ai-discovery.md)

> **Beta status:** scaffolding and local typechecks/unit tests exist; fresh-account deployment, privacy retention/deletion, and full Basin pipeline verification remain pending. Use test resources, not sensitive production data.

## Platform

| Capability | Implementation |
| --- | --- |
| Private analytics ingestion | Effect schemas, native Worker RPC, per-source authenticated capture |
| Durable event history | Basin Pipelines → R2 Iceberg, optional direct R2 fallback |
| Application integration | `@flightdeck/sdk-worker`, `@flightdeck/sdk-effect`, `@flightdeck/browser` |
| First-party browser collection | Authenticated app route + explicit event/property allowlist |
| Analytics console | React + Vite, Worker and Cloudflare Access JWT validation |
| Insights | Events, trends, funnels, cohorts, RUM, Flagship exposure counts |
| Live journeys | Optional Queue and SQLite Durable Object state machines |
| AI journey interpretation | Optional Workers AI; aggregate graph-derived evidence only |

**Flagship remains separate.** Flags and rollouts live in the Cloudflare dashboard; Flightdeck only analyzes exposures and outcomes.

## Guided first install

```sh
pnpm install
pnpm wizard -- --dry-run
pnpm wizard
# Optional: provision Access from the local cf CLI (see docs/admin-mcp.md)
```

The wizard uses your local Wrangler session to guide D1, Basin, Cloudflare Access and private Worker deployment. After setup, open `/#admin` in the separately hosted Flightdeck console to create source credentials, inspect configuration checks and manage sources. Admin MCP is optional and requires a separate Access policy.

## Get started

The release hardening stack also includes a dry-run-only account-owned deployment planner, D1 metadata backup/restore helpers, and a first-party browser → authenticated Worker → Core RPC → durable sink integration test.

Node.js 22+, pnpm 10+, Cloudflare account with Workers Paid for Basin.

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm exec wrangler login
```

Set up the Basin stream through `pnpm exec wrangler basin pipelines setup` using `basin/events.schema.json`. Then:

```sh
pnpm setup -- --mode basin --stream-id YOUR_STREAM_ID
pnpm doctor
```

Deploy the console with `pnpm setup:console` after configuring Cloudflare Access. Details and security checks are in [installation](docs/installation.md).

## Sample Worker

```ts
import { createFlightdeck } from "@flightdeck/sdk-worker";

const analytics=createFlightdeck({
  binding:env.FLIGHTDECK,
  sourceId:env.FLIGHTDECK_SOURCE_ID,
  sourceToken:env.FLIGHTDECK_SOURCE_TOKEN,
}).withContext({ actorId: user.id });

await analytics.track("project.opened",{template:"blank"});
```

Your app's `wrangler.jsonc` needs:

```json
{ "services":[{"binding":"FLIGHTDECK","service":"flightdeck-core"}] }
```

See [Worker](examples/worker-collector.ts) and [Durable Object](examples/durable-object.ts) integrations.

## Engineering

See [AGENTS.md](AGENTS.md), [roadmap](docs/roadmap.md), and [deployment RFC](docs/deployment.md). The repo is a pnpm monorepo with tests for source isolation, ingestion failure, SDK dispatch, browser forwarding, bounded Basin SQL, and deterministic journey models.

## License

MIT.

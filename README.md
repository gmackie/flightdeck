# Flightdeck

**Open-source, account-owned behavioral analytics and application intelligence on Cloudflare.**

Flightdeck gives existing Workers and Durable Objects a typed, private **service binding** for analytics. Those Workers authenticate their own users, handle their own browser event endpoints, and submit approved events through the Flightdeck core. No mandatory public Flightdeck collector is necessary.

[Separate-workspace deployment](docs/deploy-workspace.md) · [Agent MCP](docs/agents-mcp.md) · [Agent issue handoff](docs/agent-handoffs.md) · [Process Twin](docs/digital-twin.md) · [Release gates](docs/release-gates.md) · [Installation guide](docs/installation.md) · [Service binding integration](docs/service-bindings.md) · [Architecture](docs/architecture.md) · [Source governance](docs/source-governance.md) · [Privacy](docs/privacy-and-retention.md) · [Console](docs/console.md) · [AI discovery](docs/ai-discovery.md)

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

## Install into your Cloudflare account

```bash
pnpm install
pnpm install:cloudflare
```

The guided wizard selects a Cloudflare account, provisions private service-binding ingestion, D1, R2/Basin Catalog, a Basin stream/pipeline, an Access-protected console, and optional Queue/DO, Workers AI, and MCP. It deploys the Console **locked first**, then configures Cloudflare Access and verifies anonymous requests are denied. Existing app Workers/DOs keep authentication and forward telemetry over private bindings.

The wizard supports `--dry-run`, `--yes --apply`, resumable installation manifests, and a complete noninteractive mode with scoped Cloudflare API/Catalog tokens. Read [install wizard](docs/install-wizard.md) and [administrator UI/MCP](docs/admin.md).

## Administrator UI and MCP

Flightdeck includes an Access-protected Administration workspace for application Worker/DO registration, source token rotation, collection policies, query/AI budgets, system health and reviewable change requests. The optional MCP server can inspect administration status and propose typed changes; a separate administrator must approve them in the UI. No source credentials are returned through MCP.

See [Admin console](docs/admin.md) and [Admin MCP](docs/admin-mcp.md).

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

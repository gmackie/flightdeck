# Verified two-app demo

Use a dedicated installation and synthetic fixtures before enabling real telemetry.
The fixtures represent a ForgeGraph delivery funnel and a Wafflehouse game funnel;
they do not subscribe to real user activity or prove production delivery.

## Account prerequisites

All Workers and private service bindings must be in the same Cloudflare account.
Use the account that owns the consumer deployments. Wrangler OAuth can deploy Workers,
D1 and Basin resources, but may lack Access organization permissions. Before installation,
provide an account-scoped API token with Workers, D1, R2, Pipelines/Basin and Access
organization/application/policy permissions. R2 must be enabled and billing accepted.
The installer probes read access before creating resources; this does not guarantee write access or quota.

Set `CLOUDFLARE_API_TOKEN` and `FLIGHTDECK_CATALOG_TOKEN` through your secret manager.
The Catalog token needs Cloudflare's R2 Catalog Admin Read & Write capability and is
also used to query the dedicated Catalog. Do not commit either token or put it in command arguments.
`forge creds get cloudflare --show` cannot export a server-managed integration token.
`forge r2 create` provisions S3 credentials; those do not replace a Catalog API token.

## Install and seed

```sh
pnpm install --frozen-lockfile
pnpm install:cloudflare -- --apply --account-id ACCOUNT_ID --slug demo \
  --admin-emails me@gmac.io --mode standard --skip-mcp
node scripts/setup-demo.mjs --dry-run
node scripts/setup-demo.mjs --apply
```

The installer builds before deployment and keeps credentials in `.flightdeck/`.
Back up that directory securely. Setup creates two staging-only sources in the default
project with consent required and fixed event/property allowlists. Existing source credentials
and policies must match; setup refuses collisions. Protect `.flightdeck/demo-secrets.json`.

## Consumer Workers

ForgeGraph includes `apps/web/wrangler.flightdeck-demo.jsonc`; Wafflehouse includes the
same filename. Both bind privately to `flightdeck-demo-core`. Deploy these dedicated
Workers first rather than modifying a production stage. From each app's `apps/web`:

```sh
pnpm exec wrangler deploy --dry-run --config wrangler.flightdeck-demo.jsonc
pnpm exec wrangler deploy --config wrangler.flightdeck-demo.jsonc
pnpm exec wrangler secret put FLIGHTDECK_SOURCE_TOKEN --config wrangler.flightdeck-demo.jsonc
pnpm exec wrangler secret put FLIGHTDECK_DEMO_TOKEN --config wrangler.flightdeck-demo.jsonc
```

Supply each source's own token and the shared demo token from the private JSON using
secret-manager stdin. Configure the explicit account ID through `CLOUDFLARE_ACCOUNT_ID`.
Until both secrets exist, the endpoint cannot emit fixtures. The normal application
adapters are also opt-in and need the same private binding/configuration when later enabled.
Wafflehouse runs the SDK through its Effect runtime and effect-cf tracer.
Vendored SDK tarballs include checksums and license; replace them with published versions
before general consumer rollout.

## Prove the full path

Sign into the dedicated console through Access. Deliver the `CF_Authorization` cookie
as `FLIGHTDECK_ACCESS_COOKIE` and the demo secret as `FLIGHTDECK_DEMO_TOKEN` through
your secret manager. Never paste them into an issue or evidence file.

```sh
node scripts/verify-demo.mjs \
  --console https://flightdeck-demo-console.gmac.workers.dev \
  --forgegraph https://flightdeck-demo-forgegraph.gmac.workers.dev \
  --wafflehouse https://flightdeck-demo-wafflehouse.gmac.workers.dev \
  --out .flightdeck/demo-evidence.json
```

Use a quiet dedicated installation: the funnel assertions expect exactly one actor per
source in the verification window. The verifier checks anonymous denial, authenticated
D1/Core/config health, private stream receipts, eventual SQL visibility of eight stable
fixture IDs, deduplication after two retries, and both four-stage funnels. It times out
after five minutes. Component health alone explicitly reports `eventPathVerified:false`.

## Launch gates

Do not claim the demo is live until this verifier passes against deployed resources.
Record resource account, deployment versions, source revisions and the resulting evidence
on FLIG-1, FORGE-242 and AW-11. Keep production issues open until their intended target is
verified. Physical privacy deletion, retention, recovery drills, load/cost evidence and
published SDK installation remain requirements for a general launch. Installer source
revision invalidation redeploys code; changes to existing Basin schemas or immutable
Access/topology options still require an explicit operator migration.

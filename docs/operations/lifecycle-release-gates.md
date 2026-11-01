# Lifecycle release gates and integration preflight

`scripts/lifecycle-preflight.mjs` checks whether the lifecycle + MCP code on a branch is ready to
integrate, and whether it could be called safe for production. It is **local and read-only**:
it reads files in this checkout, runs only allowlisted local commands when you ask (`--run`),
never prints secret values, and never calls Cloudflare, Flightdeck, OAuth, Basin or any other
remote API. Live staging checks are manual. An operator records them as attestations, described
below.

```bash
node scripts/lifecycle-preflight.mjs                                   # static gates only
node scripts/lifecycle-preflight.mjs --run all \
  --config scripts/lifecycle-preflight/fixtures/synthetic-staging.json # full local run
node scripts/lifecycle-preflight.mjs --format json --report out.json   # machine-readable
node --test "scripts/lifecycle-preflight/test/*.test.mjs"              # harness tests
```

Add `--disable-warning=ExperimentalWarning` to hide Node's `node:sqlite` notice.

## Statuses and verdicts

Each gate is `pass`, `blocked` or `unknown`. **Only `pass` is green.** `unknown` means "not
shown". This covers a command not run, input not supplied, no attestation, a stale attestation
or a check that crashed. It never counts as passed.

| Verdict | Ready when |
| --- | --- |
| `integration-ready` | Every integration gate passes, including every command gate **run in this invocation**. It says nothing about a Cloudflare account. |
| `production-safe` | Every gate passes, integration gates included, **and** the config's `environment` is `staging`. Synthetic or absent input can never produce it. |

`--require integration-ready|production-safe` exits 1 when that verdict isn't `ready`. Exit 2 means
a usage or config error, such as a secret in the config or an unknown flag.

**On current main (53a9382) `production-safe` is BLOCKED by design:**

- `source-completeness`: `PRODUCTION_ENABLED = false` in `apps/lifecycle-mcp/src/config.ts`.
- `oauth-metadata`: the MCP Worker doesn't serve `/.well-known/oauth-protected-resource`.
- `d1-retention`: the erasure migration from FLIG-35 isn't integrated.
- `query-budgets`: the budget migration from FLIG-36 isn't integrated.
- Every live gate is `unknown` until an operator attests to it.

`flags-default-off` *requires* `PRODUCTION_ENABLED = false`, while `source-completeness` blocks
until it is flipped. So no single commit passes both until a reviewed change updates this
manifest along with the flip. That is deliberate.

## Gate manifest

Gates are data in `scripts/lifecycle-preflight/gates.json`, validated against
`gates.schema.json`. Each gate names a check implemented in `lib/checks.mjs`; an unknown check
name is a manifest error. Command gates name ids from the fixed allowlist in `lib/commands.mjs`.
The manifest can't add commands.

| Gate | Needed for | How it is decided |
| --- | --- | --- |
| `workspace-components` | integration | Lifecycle packages and apps exist; pnpm is pinned; a lockfile exists; Node ≥ 24 |
| `d1-migrations` | integration | `NNNN_name.sql` names, no duplicate number, the required baseline is present in order, and every file applies to a blank in-memory SQLite database (`node:sqlite`) |
| `flags-default-off` | integration | Committed `vars` hold their default-off values; opt-in bindings (`LIFECYCLE_EVENTS`, `LIFECYCLE_READ_API`) aren't committed; `PRODUCTION_ENABLED = false` |
| `no-committed-secrets` | integration | No secret-shaped `vars`; no tracked `.dev.vars` or `.env` files |
| `rpc-entrypoint` | integration | `LifecycleReadEntrypoint` is exported; it refuses `LIFECYCLE_MCP_ACCESS_AUD == ACCESS_AUD`; MCP `workers_dev` and `preview_urls` are false |
| `mcp-protocol` | integration | MCP server and client SDKs pinned exactly at v2+; worker declares protocol `2026-07-28` |
| `privacy-k-floor` | integration | `MIN_COHORT_FLOOR` and `LIFECYCLE_MCP_MIN_COHORT` ≥ 5, and the config's `privacy.minCohort` ≥ 5 |
| `pipeline-schema` | integration | `lifecycle_events.schema.json` has typed required fields and no personal-data-like names |
| `basin-sql-readonly` | integration | Generated and checked-in Basin SQL is one `SELECT`/`WITH` statement, with no DML or DDL |
| `local-quality`, `synthetic-fixtures`, `wrangler-dry-run`, `two-domain-acceptance` | integration | The allowlisted command passed in this run |
| `access-audiences` | production | Config dashboard and MCP AUDs are present and different (shown as fingerprints); no synthetic AUDs on staging |
| `rpc-service-binding` | production | Config binding `LIFECYCLE_READ_API` targets `flightdeck` / `LifecycleReadEntrypoint`; any other service is blocked |
| `staging-flag-plan` | production | Intended flags are allowed for a live stage (`READ_AUTHZ_MODE=enforce`, dev bypasses off) |
| `oauth-metadata` | production | The Worker serves RFC 9728 metadata, and the fixture is well-formed |
| `d1-retention` | production | The erasure migration is integrated; retention is enabled with bounded days. Disabled retention is blocked |
| `query-budgets` | production | The budget migration is integrated; budgets are positive and bounded |
| `source-completeness` | production | Production switch on (future) |
| `access-live`, `oauth-live`, `basin-provisioned`, `erasure-certificate`, `audit-retention-live`, `rollback-rehearsed` | production | Operator attestation |

### D1 migration baseline

Current main applies, in order: `0001_apps`, `0002_server_ingest_keys`, `0003_dogfood_app`,
`0004_hourly_rollups`, `0005_lifecycle_write`, `0006_process_definitions`,
`0010_read_authorization`, `0020_lifecycle_serving` and `0030_lifecycle_projection`. A test
asserts that this list equals the files on disk. New migrations, such as erasure jobs (FLIG-35)
and query budgets (FLIG-36), must take an unused number above `0030` and be added to
`migrations.required`. Two files with the same number block the gate, because whichever branch
lands second would apply in an order no reviewer saw.

## Input config (never secrets)

`--config` takes a JSON file matching `config.schema.json`. It holds intended staging settings:
hostnames, Access team domain and AUD tags, flags, service bindings, the OAuth metadata fixture
path, retention, budgets, k, and attestation paths. `--from-env` reads only these variables:
`FLIGHTDECK_PREFLIGHT_ENVIRONMENT`, `_DASHBOARD_HOST`, `_MCP_HOST`, `_ACCESS_TEAM_DOMAIN`,
`_DASHBOARD_AUD` and `_MCP_AUD`.

The config is refused, with only the offending path named, when it has:

- an unknown key, flag or flag value;
- a secret-like key (token, secret, password, API key, cookie, authorization) or value (JWT,
  PEM, bearer, high-entropy string);
- an evidence path outside the repository;
- or a non-reserved hostname in an `environment: synthetic` config.

Reserved hostnames are `*.example`, `*.example.com`, `.net` and `.org`, `*.test`, `*.invalid`
and `localhost`. AUD tags aren't secret, but reports show them only as `fp:xxxxxxxx`
fingerprints.

## Commands (`--run`)

`lint`, `typecheck`, `test`, `build`, `pack-smoke`, `fixtures-test`, `fixtures-validate`,
`wrangler-dry-run-flightdeck`, `wrangler-dry-run-mcp`, `mcp-acceptance`, or `all`. Each is a
fixed argv run without a shell. Children get an allowlisted environment with
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_API_KEY` and `CLOUDFLARE_ACCOUNT_ID` emptied, and
`NODE_OPTIONS` dropped. Wrangler runs with an empty `XDG_CONFIG_HOME`, so a developer's
`wrangler login` token is invisible to it. Output is redacted and written to
`<out-dir>/logs/<id>.log`. `wrangler deploy --dry-run` bundles without uploading. `pack-smoke`,
like `pnpm install`, may contact the npm registry. Nothing else is intended to use the network.

`--remote`, `--live`, `--production`, `--deploy`, `--account` and `--api-token` are refused.
Remote verification isn't implemented. Adding it needs a separate, reviewed opt-in.

## Basin SQL and physical erasure

Basin (R2 SQL) is a read-only query engine over R2 Data Catalog (Apache Iceberg) tables. The
preflight blocks any Basin SQL that isn't a single `SELECT`/`WITH`, including `INSERT`,
`UPDATE`, `DELETE`, `MERGE`, DDL and stacked statements. **Deleting lifecycle rows therefore
needs an external Iceberg engine** (for example Spark, Trino or PyIceberg) connected to the R2
Data Catalog REST endpoint. Then:

1. commit a `DELETE`;
2. expire the snapshots that still reference the deleted rows;
3. remove orphan files;
4. confirm absence with a Basin `SELECT`;
5. apply D1 tombstones.

Only an `erasure-certificate` attestation with all five checks true and a named `engine` can
pass that gate. A synthetic certificate is blocked.

## Operator attestations

A live gate passes only when `config.attestations.<gate>` points to a repository-relative JSON
file that:

- matches `attestation.schema.json`;
- names this exact `commit` (40 hex);
- is `synthetic: false`;
- is at most 30 days old and not dated in the future;
- sets every required check for that gate to `true`;
- and contains nothing secret-shaped.

A different commit or an older file is `unknown`, not `pass`. The harness checks the file's
shape, not the facts in it. The report says "operator-attested; not independently verified".

## Non-disruptive staging checklist (manual)

These steps need an operator with access to the **actual staging Cloudflare account**. Use
synthetic data only. Don't touch production and don't use real personal data. Record each
section as an attestation.

**Access, TLS and hostnames (`access-live`)**

- Access protects every hostname that serves the dashboard and `/api/*`, including workers.dev,
  or workers.dev is disabled. See the [workers.dev routing docs][workersdev].
- The MCP Worker has its own [self-hosted Access application][access-app], and its AUD differs
  from the dashboard's.
- On the MCP Worker, `workers_dev` and `preview_urls` are false.
- The TLS certificate is valid on both hostnames.
- A request without a JWT, and one with the dashboard AUD sent to MCP, are both rejected.
  See [validating Access JWTs][access-jwt].

**OAuth (`oauth-live`)**

- Protected-resource metadata ([RFC 9728][rfc9728]) is served over TLS.
- Tokens are audience-bound to the MCP resource; expired and wrong-resource tokens are rejected.
- No token is passed through to the backend. See the [MCP spec][mcp] and Cloudflare's
  [MCP authorization][cf-mcp-auth].

**Pipelines, Basin and R2 (`basin-provisioned`)**

- The [Pipelines][pipelines] stream schema matches `lifecycle_events.schema.json`.
- The sink writes an Iceberg table in [R2 Data Catalog][r2-catalog].
- The [R2 SQL][r2-sql] query token is read-only and scoped to that bucket.
- A synthetic row can be queried.

**Service binding.** Add `LIFECYCLE_READ_API` → `flightdeck` / `LifecycleReadEntrypoint`
([RPC][rpc]) only in the staging config. Set `LIFECYCLE_MCP_READ_ENABLED=1` and a distinct
`LIFECYCLE_MCP_ACCESS_AUD` on the backend.

**Audit and retention (`audit-retention-live`).** Audit rows hold opaque ids only. Review the
retention dry run. Run the retention job on synthetic data, and confirm the replay log isn't
truncated before checkpoints.

**Erasure (`erasure-certificate`).** Follow the five steps above on a synthetic case. See
[Iceberg maintenance][iceberg].

**Rollback (`rollback-rehearsed`)**

- Turning the flags off restores the previous behaviour.
- The service binding is removed.
- The previous Worker version is restored ([rollbacks][rollbacks]).
- Migrations are forward-compatible. D1 has no down migrations
  ([D1 migrations][d1-migrations]).

The links point to official Cloudflare, IETF, Apache Iceberg and MCP documentation. They weren't
fetched when this was written; check them against the current docs before use.

## CI

`.github/workflows/lifecycle-integration-preflight.yml` runs only on `workflow_dispatch` and on
pushes to `integration/lifecycle-**` and `feat/lifecycle-integration-**`. It has no secrets and
read-only `contents` permission, and checks out without persisted credentials.

- `pnpm/action-setup` runs before `setup-node` with `cache: pnpm`, the order that fixes the
  earlier cache bug.
- The harness-test job uses only Node, with `package-manager-cache: false`.
- Push runs only report. `integration/*` branches require `integration-ready`.
- A dispatch run can require it via the `require` input.

## Limits

- No live state is observed. All live gates rely on attestations, and those are checked for
  form, not truth.
- Static checks read source text with patterns, for example the AUD guard and `PRODUCTION_ENABLED`.
  A refactor can turn them `blocked` until the manifest is updated. They fail closed.
- Applying migrations to `node:sqlite` isn't D1. D1-only SQL could be falsely blocked, and runtime
  data issues aren't caught.
- The Basin SQL check covers the demo query from the built `lifecycle-queries` package and any
  `.sql` files in the configured directories. It doesn't cover every query an executor may build.
- `privacy-k-floor` checks the k floor only. Resistance to differencing attacks needs separate
  review (FLIG-36).

[workersdev]: https://developers.cloudflare.com/workers/configuration/routing/workers-dev/
[access-app]: https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-public-app/
[access-jwt]: https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
[rfc9728]: https://www.rfc-editor.org/rfc/rfc9728
[mcp]: https://modelcontextprotocol.io/specification/
[cf-mcp-auth]: https://developers.cloudflare.com/agents/model-context-protocol/authorization/
[pipelines]: https://developers.cloudflare.com/pipelines/
[r2-catalog]: https://developers.cloudflare.com/r2/data-catalog/
[r2-sql]: https://developers.cloudflare.com/r2-sql/
[rpc]: https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/
[iceberg]: https://iceberg.apache.org/docs/latest/maintenance/
[rollbacks]: https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/
[d1-migrations]: https://developers.cloudflare.com/d1/reference/migrations/

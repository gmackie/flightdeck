# Lifecycle read authorization (Workstream E / FLIG-18)

This foundation is proposed in a **draft PR only**. No migrations, rollout flags,
merge, or deployment have been applied to production by this workstream.

## Trust boundary and roles

The dashboard Access JWT authenticates the caller once, using the configured team,
RS256 signature, issuer, expiry, and dashboard audience. The same verified
`AccessPrincipal` flows into `authorizeApp` / `authorizeLifecycleRead`; a second
Access application JWT is not needed. `apps.access_aud` belongs to ingestion and
is never consulted for dashboard reads. Ingestion bearer tokens and service
bindings carry no dashboard authorization. Client headers, query parameters,
roles, email addresses, and app IDs do not create grants.

Grant subjects use the verified Access person's `sub` or service `common_name`,
with separate `person` and `service` namespaces. A service claim takes precedence
over person-like claims, preventing service tokens from inheriting person grants.
Email is neither an authorization key nor stored in authorization tables.

| Role | App live/trends | Lifecycle policy | Process projection | Policy management authority |
| --- | --- | --- | --- | --- |
| reader | yes | yes | no | no |
| analyst | yes | yes | yes | no |
| owner | yes | yes | yes | scoped |
| admin | yes | yes | yes | scoped |

Services may only receive app-scoped `reader` grants; the migration and helper
both enforce this ceiling. Services cannot inherit project grants, run process
projections, or manage grants. Owner and admin currently share scoped capabilities;
admin provides no wildcard or global superuser. There is no personnel-data endpoint.
Visibility groups are deliberately deferred; project membership supplies the
explicit inheritance boundary without group synchronization or email claims.

`authz_projects` is an authorization namespace, not an ingestion schema. Each app
may have one `authz_app_projects` membership. A person with a project grant can
read apps currently mapped to that project. Adding/reparenting an app therefore
changes authority and requires an operator review. App grants remain scoped to
that app regardless of project membership. No membership is inferred from names.

## Bootstrap and management

There is intentionally **no HTTP grant-writing API**, self-enrollment, automatic
first-user admin, or grant-on-registration. Access to legacy app registration and
server-key administration does not grant D1 policy administration. The
`policy:manage` capability is available for a later separately reviewed management
API; it does not currently expose a mutation route. Database operators remain the
trusted bootstrap and recovery path and must have Cloudflare D1 IAM permission.
Application-level owner/admin does not itself confer Cloudflare IAM access.

A trusted operator should apply `0010_read_authorization.sql` with the standard D1
migration command in a scheduled rollout, then provision known Access subjects
from their verified identity. The following uses synthetic placeholders only:

```sql
INSERT INTO authz_projects (id) VALUES ('project_example');
INSERT INTO authz_app_projects (app_id, project_id)
VALUES ('app_example', 'project_example'); -- app must already exist
INSERT INTO authz_grants
  (id, principal_kind, principal_subject, project_id, role)
VALUES ('grant_bootstrap', 'person', '<verified-access-sub>', 'project_example', 'admin');
INSERT INTO authz_grants
  (id, principal_kind, principal_subject, app_id, role, expires_at)
VALUES ('grant_service', 'service', '<verified-service-common-name>', 'app_example',
        'reader', 1893456000000);
-- Revoke without deleting the audit record:
UPDATE authz_grants SET revoked_at = unixepoch() * 1000 WHERE id = 'grant_service';
```

Use an operator-reviewed SQL file with `pnpm --filter @flightdeckhq/app exec
wrangler d1 execute flightdeck --remote --file <approved-policy.sql>` when an
actual production rollout is authorized. Keep identity-bearing SQL out of source
control and CI logs. Limit D1 access, retain Cloudflare operator audit history,
and record a non-sensitive change/ticket reference for provisioning and revocation.
Do not use request logs as a grant audit store. The current table preserves creation,
expiry and revocation, but is not an immutable administrative audit ledger.

Grants are checked against D1 on every request, with no grant cache. Revocation,
expiry, and membership removal take effect on the next authorization decision.
Unknown apps and ungranted apps both return 403. D1 errors (including an unapplied
migration) return a generic 503 without exception text or principal logging.
Local `FLIGHTDECK_DEV=1` authentication does not bypass sensitive authorization;
Access team/audience must be configured for these reads even in development.

## Routes and future endpoint contract

- `GET /api/apps/:appId/lifecycle/policy`: requires `lifecycle:read`; returns only
  the static release policy, version, and canonical authorized app ID.
- `GET /api/apps/:appId/lifecycle/projection?dimensions=workflow,phase`: requires
  `process:read`; validates and returns a release projection descriptor. It does
  not query ingestion storage or pretend that lifecycle aggregates already exist.
- The lifecycle namespace is guarded even for unknown endpoint names. Unknown
  endpoints return 404 only after authorization. All responses use `no-store`.

Every future lifecycle read must pass the already authenticated principal and
**route-derived** app ID to `authorizeLifecycleRead` before loading any records.
Return its Response on denial. Use only the returned scope's app ID in queries;
never accept an overriding app ID, role, or scope in the payload. For aggregate
releases, request `process:read` and call `projectLifecycleAggregates` with that
opaque request-local scope. Do not persist or reuse scopes across requests.

No changes to lifecycle ingestion, events, pipelines, or rollup schema are made.
Migration 0010 is independently named to reduce collisions with concurrent
workstreams. Recheck migration ordering/names when integrating their PRs.

## Legacy production rollout

`READ_AUTHZ_MODE=legacy` is explicit in wrangler config; absent/empty also preserves
the currently deployed live/live-ws/trends behavior. Those routes still require
the dashboard Access JWT, but do not require a per-app grant in legacy mode.
New lifecycle routes always require grants regardless of this setting. An unknown
nonempty mode produces 503 on legacy read routes rather than disabling checks.

For an authorized later rollout:

1. Apply the authorization migration without changing the mode. Provision human
   and service grants; inventory dashboard users and automation beforehand.
2. Verify policy and projection access for allowed callers and denial for outsiders.
   Validate app/project memberships, expiry, revocation, and service ceilings.
3. Test `READ_AUTHZ_MODE=enforce` in a separate environment, including live socket
   handshakes and trends. Existing sockets are authorized at handshake only; drain
   or terminate existing connections at cutover or urgent revocation. Subsequent
   socket messages do not re-query grants; continuous socket revocation is deferred.
4. Switch the production setting explicitly after review. Missing grants or D1
   failures deny reads in enforce mode. Observe status-only errors without tokens,
   subjects, request queries, or payloads. Rollback to `legacy` only under an
   explicit operator decision; that restores broad legacy dashboard visibility.

The app directory and legacy registration/key-management API retain their previous
Access-wide policy. This PR does not claim they are private or migrate write
administration. Avoid putting sensitive app names/identifiers in that directory;
a future directory/write-management rollout needs its own compatibility review.

## Privacy release boundary and residual risks

Only categorical `workflow`, `phase`, and `outcome` dimensions are classified as
aggregate. Their **values** also come from fixed enums; a nominally safe key cannot
smuggle an email, name, URL, trace ID, or other identifier as its value. Unknown
keys, identifiers, pseudonymous/hashed identifiers, duplicate projections, and
schema drift fail closed. No free text, raw records, actor IDs, or raw timestamps
are returned. The release helper reconstructs output instead of spreading records.

A future trusted storage adapter must aggregate by exactly the selected dimensions
and compute `cohort_size` from distinct protected subjects at the correct privacy
unit, not event volume. The helper rejects mismatched app scope, extra dimensions,
duplicate groups, invalid counts and non-allowlisted values; it suppresses cohorts
below five and rounds released counts down to a multiple of five. Neither cohort
sizes, suppressed counts, nor marginals/totals are returned. A hundred events from
four subjects remain suppressed. Reader grants cannot call the aggregate boundary.

This is a reusable release guard, **not a proof of anonymity**: overlapping time
windows, complementary queries, external knowledge, and repeated releases can
still reveal small groups. Before exposing real sensitive workflows, define stable
cohorts and windows, query budgets/complementary suppression (or differential
privacy), retention, purpose restrictions, and audited schema approval. The
projection route is deliberately schema discovery only until that storage/query
contract is reviewed. Arbitrary SQL, caller-supplied cohorts, and raw lifecycle
reads must never be wired to it. No personnel data is introduced in this PR.

Tests follow the root Vitest projects and Cloudflare worker/D1 harness, applying
real migrations through `test/setup.ts`. Run root `pnpm lint`, `pnpm typecheck`,
and `pnpm test`; CI additionally runs browser size and package smoke checks.

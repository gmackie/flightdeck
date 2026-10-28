# Account-owned Flightdeck control plane (Beta)

A D1 database stores **metadata only**; the canonical event lake remains Basin/Iceberg.

The Cloudflare Access-protected console exposes project-scoped endpoints:

| API | Methods | Scope |
| --- | --- | --- |
| `/api/insights` | GET, POST | Saved query specifications, rolling 1–90 day windows |
| `/api/insights/:id` | PUT, DELETE | Modify saved insights |
| `/api/insights/:id/run` | POST | Execute a saved DSL query, subject to query budget |
| `/api/dashboards` | GET, POST | Dashboard layouts referencing insight IDs |
| `/api/dashboards/:id` | PUT, DELETE | Layout management |
| `/api/sources` | GET | Redacted source inventory |
| `/api/query-budget` | GET | Relative query usage |
| `/api/audit` | GET | Administrator-only changes |

All data is scoped to a project ID configured in the Worker environment, never from an untrusted browser request. Reads require a valid Cloudflare Access JWT. Mutations require an admin email allowlist and same-origin request, with D1 audit entries.

Apply `migrations/0001_metadata.sql` and `migrations/0002_query_governance.sql`. Bind the database to the console as `META` and optionally a KV namespace as `QUERY_CACHE`. Set `QUERY_MONTHLY_UNITS` to a carefully chosen monthly relative query cap and set `ADMIN_EMAILS` to the identities authorized to edit definitions. Leave `QUERY_QUOTA_REQUIRED` enabled. A missing database results in an unavailable response, not unrestricted queries.

This first implementation does not yet deliver an organization-level role hierarchy or a multi-project admin UI. The default deployment isolates one installation/account and a single configured project. API access alone does not prove legally compliant data processing: see privacy RFC.

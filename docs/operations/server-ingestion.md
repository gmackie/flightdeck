# Server ingestion and Bob onboarding (FLIG-8)

`POST /v1/server/events` accepts JSON `{ "events": [...] }` using
`Authorization: Bearer <app-scoped-key>`. It is independent of browser Access
identity and dev routes. Only `track` events are accepted; the normal event
schema applies (1–50 events, scalar props, valid IDs). Requests are limited to
256 KiB, including chunked bodies. Use HTTPS and do not follow redirects.

App identity comes only from the credential registry. Extra envelope fields
(including `appId`, `accessJwt`, `context`) are rejected. The key is authorized
for one registered app and cannot choose another app. Producers remain trusted
to select event names and props, so keep each credential private to its service.

Keys carry scopes (`server_ingest_keys.scopes`, migration 0005). Keys default to
`events.write`, which this endpoint requires; a key holding only `lifecycle.write` gets 403
here. Lifecycle events use their own endpoint and grants:
[lifecycle-ingestion.md](lifecycle-ingestion.md).

Apply D1 migrations before deploying the endpoint. Register Bob in `apps` as
`app_bob` and store an expiring key's SHA-256 hex digest in
`server_ingest_keys(token_hash, app_id, expires_at)`; expiry is epoch milliseconds.
Generate at least 32 random bytes and encode base64url. Provision the raw key
through Bob's secret environment as `BOB_FLIGHTDECK_TOKEN`. Never put it in SQL,
command-line arguments, PRs or logs. The database contains only its digest.
Provision using operator-owned secret tooling and parameterized D1 statements.

Rotate by adding a second expiring key for the same app, updating Bob, verifying
accepted events, and deleting the previous digest. Keys are checked on every
request, so revocation is immediate. Deleting an app cascades its keys. Keep
`FLIGHTDECK_DEV=0`; do not use `/__dev/apps` in production.

A 200 response includes accepted/rejected counts. Pipeline completion is the
acceptance point. Invalid credentials return 401, keys without `events.write` 403, invalid envelopes 400, wrong
content type 415, oversized bodies 413, and unavailable storage/sinks 503 with
`Retry-After: 5`. Per-event validation can return 200 with rejected events.
Only checkpoint a batch when every event was accepted. Retry network/503 failures
with bounded exponential backoff and unchanged event IDs. Storage is at least
once; deduplicate downstream by `(app_id, event_id)`.

Bob's BOB-62 exporter reads durable coordinator admission/terminal facts and
allowlists correlation IDs. Deploy this API first, then configure its endpoint,
credential and independent checkpoint path in Bob's worker. Validate a scratch
plan's admission and completion events under `app_bob`, check hour counters,
record the Pipeline event IDs, and verify worker/issue behavior during a forced
analytics outage. Production acceptance and health evidence are still required;
local regression tests alone do not constitute onboarding completion.

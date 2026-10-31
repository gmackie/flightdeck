# Lifecycle ingestion (FLIG-19)

Lifecycle events describe how a **case** (a job application, a deploy, an incident) moves
through the **stages** of a versioned **process**. They are separate from product analytics
events: their own contract (`LifecycleEventV1` in
[`@flightdeckhq/schema`](../../packages/schema/src/lifecycle.ts)), their own authorization,
their own Pipelines stream (`fd_lifecycle_events`) and their own Iceberg table
(`flightdeck.lifecycle_events`). The existing `/_fd/e`, `/v1/server/events`, `ingest`, `track`
and `identify` paths are unchanged, and lifecycle events never reach the `events` stream,
SessionDOs or AppDO counters.

This workstream covers typed events and safe ingestion only. Process analytics (FLIG-16) and
the lifecycle dashboard (FLIG-15) read the table this one writes.

## Contract

Every event carries:

| Field | Rule |
| --- | --- |
| `schemaVersion` | Must be `1`. Any other value, or none, is rejected (`unsupported_schema_version`). |
| `eventId` | 8-64 chars of `[A-Za-z0-9_-]`. Minted once by the producer and resent unchanged on retry. |
| `processId`, `processVersion` | Lowercase key; integer 1-1,000,000. |
| `type` | One of the transitions below. |
| `caseId` | Opaque id, 1-128 chars of `[A-Za-z0-9_.:-]` (no `@`, no spaces). |
| `occurredAt` | Epoch **milliseconds** when it happened in the source system, from 2000-01-01 on. |
| `sourceSequence` | Integer 0 to 2^53-1, producer-assigned order (e.g. an outbox row id). |
| `source`, `reason` | Optional lowercase keys (`greenhouse`, `awaiting_approval`). |
| `relations` | Optional, at most 16 unique `{ type, objectType, objectId }`. |
| `dimensions` | Optional, at most 16 lowercase keys with short-code (`[A-Za-z0-9_.:-]`, 64 chars) or boolean values. |

Transitions and their extra fields:

| Type | Extra fields |
| --- | --- |
| `case.created`, `case.started`, `case.paused`, `case.resumed`, `case.completed`, `case.terminated`, `case.reopened` | none; stage fields are rejected |
| `stage.entered`, `stage.blocked`, `stage.unblocked`, `stage.paused`, `stage.resumed`, `stage.exited`, `stage.skipped` | required `stageId` and `stageInstanceId` |
| `object.linked`, `object.unlinked` | required `object: { type, objectId }`; optional `stageId` + `stageInstanceId` together |
| `event.corrected` | required `correction: { targetEventId, action }`; `action` is `retract`, or `amend` with `occurredAt` and/or `dimensions` |

A stage instance id distinguishes repeated visits to the same stage (a case that goes back to
`phone_screen` gets a new instance). Corrections are new rows; readers apply them to their
target instead of history being rewritten.

**Fail closed.** Objects are strict, so unknown fields (`props`, `appId`, `email`, ...) reject
the event. Keys that name personal or secret data (`email`, `phone`, `name`, `first_name`,
`address`, `ip`, `ssn`, `password`, `token`, `api_key`, ...) are rejected anywhere in an event,
in any spelling (`candidateEmail`, `e-mail`). Free text has no field to go in. Keep personal
data in the source system and send opaque ids.

`ProcessDefinitionV1` describes a process version: its stages, the allowed dimension keys with
every allowed value, and the allowed relation types. `checkAgainstDefinition(event,
definition)` checks an event against it. **Ingestion enforces only the structural schema**,
since Flightdeck has no process registry yet, so producers should run the definition check
before enqueueing.

## Authorization

Lifecycle writes need two independent grants, both checked on every request (no cache), so
revoking either takes effect at once:

1. **App capability.** An operator grants the app `lifecycle.write` in `app_capabilities`.
   There is deliberately no admin API for this. An Access session on `/api/*` can mint generic
   server keys, but it cannot let an app write lifecycle events.
2. **Credential.** On HTTP, the bearer key's `scopes` must include `lifecycle.write`. Keys
   minted before migration 0005, or by `apps key`, hold `events.write` only and get **403** on
   the lifecycle endpoint. A key holding only `lifecycle.write` gets 403 on `/v1/server/events`.
   On the service binding, the credential is the binding's `props.appId`, as for `track`.

The app always comes from the credential or binding, never from the body. An `appId` in the
envelope or in an event is rejected. There is no browser, cookie or Access path: a
`Cf-Access-Jwt-Assertion` header or a `CF_Authorization` cookie authenticates nothing here.
Producers are still trusted to choose case ids, stages and dimensions for their own app, so
keep each key private to one service.

## Provision

Use the same Cloudflare account and D1 database as the rest of Flightdeck.

1. **Migrate D1** (adds `server_ingest_keys.scopes` with default `events.write` and
   `app_capabilities`; existing keys keep working):

   ```bash
   cd apps/flightdeck && pnpm exec wrangler d1 migrations apply flightdeck --remote
   ```

2. **Create the stream, sink and pipeline.** With the dev script (needs `CATALOG_TOKEN_FILE`
   only if the sink is missing):

   ```bash
   CATALOG_TOKEN_FILE=path/to/token scripts/provision-dev.sh --lifecycle
   ```

   Or by hand, from `apps/flightdeck`:

   ```bash
   pnpm exec wrangler basin pipelines streams create fd_lifecycle_events \
     --schema-file pipelines/lifecycle_events.schema.json --http-enabled=false
   pnpm exec wrangler basin pipelines sinks create fd_lifecycle_events_sink \
     --type r2-data-catalog --bucket <bucket> --namespace flightdeck \
     --table lifecycle_events --roll-interval 60 --catalog-token <token>
   pnpm exec wrangler basin pipelines create fd_lifecycle_events_pipeline \
     --sql "INSERT INTO fd_lifecycle_events_sink SELECT * FROM fd_lifecycle_events"
   pnpm exec wrangler basin pipelines streams get fd_lifecycle_events --json   # the stream id
   ```

   Keep HTTP ingest disabled on the stream: Flightdeck is its only writer.

3. **Bind it.** Add the real stream id to `pipelines` in `apps/flightdeck/wrangler.jsonc`
   (the commented entry shows the shape), then deploy:

   ```jsonc
   { "binding": "LIFECYCLE_EVENTS", "stream": "<id printed in step 2>" }
   ```

   Never commit a made-up id. Until the binding exists, lifecycle writes answer **503** with
   `Retry-After: 60` (RPC: `lifecycle unavailable`) and nothing else changes, so producers with
   an outbox keep their events.

4. **Grant the app** (the app must already be registered):

   ```bash
   pnpm exec wrangler d1 execute flightdeck --remote \
     --command "INSERT INTO app_capabilities (app_id, capability) VALUES ('app_deploys', 'lifecycle.write')"
   ```

   Revoke with `DELETE FROM app_capabilities WHERE app_id = 'app_deploys' AND capability =
   'lifecycle.write'`. Deleting an app cascades its grants.

5. **For HTTP producers, mint a lifecycle key.** Mint the key with the CLI, so the raw key only
   goes to a 0600 file, then set its scope by digest:

   ```bash
   npx @flightdeckhq/create apps key app_deploys --days 90 --out deploys-lifecycle.key
   # prints: Key for app_deploys, digest <hex>, ...
   pnpm exec wrangler d1 execute flightdeck --remote \
     --command "UPDATE server_ingest_keys SET scopes = 'lifecycle.write' WHERE token_hash = '<hex>' AND app_id = 'app_deploys'"
   ```

   Setting `scopes = 'lifecycle.write'` removes `events.write`; use
   `'events.write lifecycle.write'` only if one service needs both. Load the key into the
   producer's secret store (for example `wrangler secret put FLIGHTDECK_LIFECYCLE_KEY <
   deploys-lifecycle.key`), then delete the file. Rotate and revoke as described in
   [server-ingestion.md](server-ingestion.md). The digest and app id are not secrets, but check
   they are a 64-char hex digest and a registered id before you paste them into SQL.

## Send events

### Service binding (Workers)

```ts
import { flightdeckLifecycle, isPermanentLifecycleError } from "@flightdeckhq/worker";

const lifecycle = flightdeckLifecycle(env); // env.FLIGHTDECK, bound with props.appId
await lifecycle.ingestLifecycleBatch({ events }); // 1-100 events, accepted or rejected whole
await lifecycle.trackLifecycle(event); // one event
```

These do not fail open, unlike `track`. A thrown error means nothing was stored. Errors
starting with `lifecycle rejected (<code>)` are permanent. `lifecycle forbidden` (no grant),
`lifecycle unavailable` (stream not bound) and transport errors are retryable.
`isPermanentLifecycleError` tells them apart.

### HTTP (trusted servers)

```http
POST /v1/lifecycle/events
Authorization: Bearer <lifecycle key>
Content-Type: application/json

{ "events": [ { "schemaVersion": 1, "eventId": "evt_01JBX9ZP8Q6M2K4T7V3W5Y1A0C", ... } ] }
```

| Status | Meaning | Producer action |
| --- | --- | --- |
| 200 `{ "accepted": n }` | The whole batch is in the stream. | Checkpoint. |
| 400 `{ "error", "issues": [{ "index", "code", "message" }] }` | Permanent rejection; at most 20 issues, values never echoed. | Fix or quarantine the listed events; resend the rest. |
| 401 | Missing, unknown, expired or revoked key. | Stop; rotate the key. |
| 403 | Key lacks `lifecycle.write`, or the app lacks the grant. | Stop; fix provisioning. Retry later without losing events. |
| 413 / 415 | Body over 256 KiB, or not `application/json`. | Send smaller batches / fix the client. |
| 503 + `Retry-After` | Stream not bound (60 s) or sink unavailable (5 s). | Retry with backoff and the same event ids. |

Issue codes: `invalid_envelope`, `unsupported_schema_version`, `prohibited_key`,
`event_too_large` (8 KiB serialized), `invalid_event`, `future_occurred_at`,
`duplicate_event_id` (within one batch). Use HTTPS and do not follow redirects.

## Time

`occurred_at` is stored exactly as sent. Unlike generic events, which are clamped to receipt
time when more than 24 hours old, lifecycle events keep their true time however old, so
backfills of historic cases are first-class. An `occurredAt` (or amended `occurredAt`) more
than **5 minutes** ahead of Flightdeck's clock is rejected (`future_occurred_at`) and never
clamped, because a clamped time would be stored as if it were true. Values before 2000-01-01
are rejected as likely epoch seconds. `received_at` records when Flightdeck accepted the row.
Order a case's events by `(occurred_at, source_sequence)`.

## Delivery and dedup

- **At least once.** A 200 or resolved RPC means the batch reached the stream. A timeout or 503
  can follow a successful write, so retries can store a row twice.
- **Dedup key `(app_id, event_id)`.** Readers keep one row per key (prefer the earliest
  `received_at`). Producers must never reuse an event id for a different fact, and must resend
  the same id for the same fact. Retrying a batch is safe.
- **All or nothing.** One invalid event rejects its batch, so a checkpoint never silently skips
  an event.

## Outbox recipe

[`examples/lifecycle-outbox`](../../examples/lifecycle-outbox/src/index.ts) is a runnable Worker:

1. In the **same D1 batch (transaction)** as the state change, insert the lifecycle event into
   `lifecycle_outbox(seq AUTOINCREMENT, event_id UNIQUE, payload, sent_at, quarantined_at)`,
   with an `eventId` minted at insert time.
2. A cron selects pending rows in `seq` order (at most 100), sets `sourceSequence = seq`, and
   calls `ingestLifecycleBatch`.
3. On success, set `sent_at`. On a retryable error, stop and let the next run retry the same
   rows. On a permanent rejection, resend the rows one at a time and set `quarantined_at` on
   those rejected for good. Alert on quarantined rows.
4. Purge sent rows after your retention window (for example 7 days).

Producers that are not Workers follow the same steps over HTTP and use the 400 `issues[].index`
values to quarantine.

## Monitoring Basin drops

Basin structured streams can **accept a record and then drop it** if it does not match the
stream schema, so a 200 is not proof the row reached Iceberg. Flightdeck checks every row
against `pipelines/lifecycle_events.schema.json` before sending (`streamProblems` in
`src/sinks.ts`) and fails the batch with a retryable 503 rather than sending a row Basin would
drop. Tests pin the record type to the schema file. If you change one, change both, and
update the provisioned stream (or create a new one) in the same release.

Still monitor it:

- Watch the `fd_lifecycle_events` stream and `fd_lifecycle_events_pipeline` metrics in the
  Cloudflare dashboard (Pipelines) for dropped or errored records, and alert on any non-zero
  value.
- Reconcile counts: per hour, compare producers' accepted counts (or the outbox's `sent_at`
  rows) with `SELECT count(DISTINCT event_id) FROM flightdeck.lifecycle_events` over
  `received_at`, allowing for the sink's 60 s roll interval.
- Worker logs carry no payloads. A 503 burst after a deploy suggests a schema mismatch or a
  missing binding.

## Validate a deployment

After provisioning, with a scratch app granted `lifecycle.write` and a lifecycle key in
`$KEY` (load it from the file, not the command line):

1. `POST /v1/lifecycle/events` with one `case.created` event returns `{"accepted":1}`.
2. Sending the same body again returns 200 (at least once). After the sink rolls, the table has
   two rows with that `event_id` and the dedup view one.
3. An event with `occurredAt` a year ago is stored with that exact `occurred_at`.
4. An event 10 minutes in the future returns 400 `future_occurred_at`.
5. A key with only `events.write` returns 403, and `/v1/server/events` with the lifecycle-only
   key returns 403.
6. Deleting the grant makes the next request return 403. Restore it afterwards.
7. The pipeline metrics show no dropped records, and `/v1/server/events`, `/_fd/e` and the
   dashboard behave as before.

Record the stream id, deployment id and these results on the issue. Local tests alone do not
complete onboarding.

## Not yet implemented

- No process-definition registry: ingestion does not check stages or dimension values against a
  published `ProcessDefinitionV1` (producers do, with `checkAgainstDefinition`).
- No admin API or CLI flag for lifecycle grants or key scopes: operators use D1 statements.
- No query API, dedup view or correction-application view over `lifecycle_events` (FLIG-16).
- No per-app rate limits or quotas beyond the batch, event and body limits.

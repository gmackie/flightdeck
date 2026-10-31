# Lifecycle fixtures

Deterministic, **synthetic** lifecycle events for three unrelated processes, plus the ground truth
they should reduce to, a validator, a late-delivery simulation and an optional HTTP producer.
Nothing here is, or is derived from, production data.

It exists so the lifecycle ingestion, engine and dashboard workstreams can test against the same
inputs and the same answers, and so a black-box smoke test can drive any endpoint that accepts the
event envelope below.

- No dependencies and no build step: plain Node (24+) ESM. It is not a pnpm workspace package, so
  it never touches `pnpm-lock.yaml`, the schema package, ingestion, the dashboard or the engine.
- Generated datasets (100k / 1M events) are written under `out/` (git-ignored) and never committed.

```bash
cd examples/lifecycle-fixtures
node --test "test/*.test.mjs"          # unit + scenario + generator tests (about 1 s)
node cli.mjs validate --fixtures       # committed scenarios + the pinned 1k golden digest
```

## The three processes

Every process is a hierarchy of _entities_; each entity moves through ordered _stages_ and ends
with an explicit _outcome_. Definitions live in [`lib/processes.mjs`](lib/processes.mjs).

| Process             | Entities (parent > child)                                              | Entity outcomes (examples)                                                             |
| ------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `recruiting`        | headcount_need > requisition > candidate > interview_loop > assessment | filled, rejected, cancelled · hired, withdrawn · advance, reject · pass, fail, no_show |
| `service_delivery`  | service > deployment > regional_rollout                                | retired, failed_provisioning · succeeded, failed, rolled_back · skipped                |
| `incident_response` | ticket > investigation > remediation (also `related_to` the ticket)    | resolved, duplicate, wont_fix · root_cause_found, inconclusive · fixed, reverted       |

Every kind also allows `cancelled`: a cancelled parent force-closes its open children with it.

## Event envelope

One JSON object per event (the fixtures' own contract, see [Assumptions](#assumptions)):

```json
{
  "eventId": "qk34og5i3oke325uz9tc",
  "appId": "app_support",
  "process": "incident_response",
  "type": "stage.exited",
  "entity": { "kind": "ticket", "id": "v8k2m0w1xq4h7c9n3b5d" },
  "version": 3,
  "occurredAt": "2026-03-02T09:15:00.000Z",
  "stage": { "name": "triage", "instanceId": "d4f7g1h9j2k5l8m0n3p6" },
  "outcome": "advanced",
  "relations": [{ "type": "child_of", "kind": "ticket", "id": "..." }],
  "attributes": { "severity": "sev2" },
  "corrects": "<eventId of the event this replaces>"
}
```

| Field                                      | Meaning                                                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `eventId`, `entity.id`, `stage.instanceId` | Opaque ids (8-64 of `[A-Za-z0-9_-]`); they carry no kind or ordering.                                                    |
| `appId`                                    | App scope. All identity (dedupe, entity, relation targets) is per app.                                                   |
| `type`                                     | `entity.opened`, `stage.entered`, `stage.exited`, `entity.paused`, `entity.resumed`, `entity.closed`, `entity.reopened`. |
| `version`                                  | Per-entity sequence, 1..n with no gaps. State is derived in version order, never arrival order.                          |
| `occurredAt`                               | When it happened (strict ISO-8601 UTC, ms). Delivery time is separate.                                                   |
| `stage`                                    | A **stage instance**: `name` plus a unique `instanceId`. Reentering a stage after a reopen is a new instance.            |
| `outcome`                                  | Explicit on `stage.exited` (`advanced`, `completed`, `terminated`) and `entity.closed` (per-kind vocabulary).            |
| `relations`                                | On `entity.opened`: `child_of` (parent), `supersedes` (a retaken assessment), `related_to`.                              |
| `corrects`                                 | This event replaces the named one (same entity and version).                                                             |

A **delivery record** wraps an event with when it was received. `events.ndjson` is a list of
delivery records, one per line, **in delivery order** (`receivedAt` never decreases):

```json
{"receivedAt":"2026-03-02T09:15:01.200Z","event":{ ... }}
```

## What the data covers

| Behaviour                        | Where it comes from                                                                                            |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Three processes                  | `--apps` (default: one app per process)                                                                        |
| Concurrency                      | sibling assessments, regional rollouts, investigations; a ticket's `customer_comms` runs beside its main stage |
| Long dwell                       | heavy-tailed stage durations; services live for weeks; open stages are measured to `asOf`                      |
| Pause, reopen                    | pausable stages; requisitions, candidates and tickets can close and reopen (new stage instance)                |
| Repeated assessment              | a failed or no-show assessment can be retaken: attempt 2 `supersedes` attempt 1                                |
| Delayed scorecard                | `scorecard_pending` dwells for days and its events are delivered late                                          |
| Pending approval                 | needs still in `pending_approval` at `asOf`                                                                    |
| Rejected / withdrawn / cancelled | per-stage exits, and cancellation cascading down a subtree                                                     |
| Late and out-of-order delivery   | lag distribution with a long tail; some entities arrive newest-first                                           |
| Duplicate ids                    | exact redeliveries (and, in one scenario, a conflicting reuse of an id)                                        |
| Corrections                      | a wrong event (outcome or timestamp) followed by a `corrects` event, sometimes arriving first                  |
| Invalid events                   | one injector per reason in `INVALID_REASONS` (21 reasons)                                                      |
| App scope separation             | apps share an id stream, so event and entity ids collide across apps on purpose                                |

## Reference semantics (the oracle)

[`lib/reduce.mjs`](lib/reduce.mjs) turns delivery records into entity records. It is a test
oracle for these fixtures, not the product engine.

1. Invalid events are rejected with a reason and have no effect (`not_an_object`, `bad_version`,
   `unknown_outcome`, ... `orphan_stage_exit`).
2. Dedupe on `(appId, eventId)`; the first delivery wins. Identical redeliveries count as
   `duplicateDeliveries`; a different payload under the same id counts as `duplicateConflicts`.
3. `corrects: X` supersedes X wherever it arrives, so the result does not depend on arrival order.
4. An entity's state is its events sorted by `version`.
5. Baseline invariants (reported as _violations_): contiguous versions, `occurredAt` non-decreasing
   by version, a legal state machine (no stage on a closed entity, no exit without an open
   instance, no close with an open stage, pause/resume/reopen only from the right state), and
   relations: parent exists in the same app, parent kind matches, parent opened first, a closed
   parent has no open child, children close no later than their parent.

## Ground truth

`expected.json` (next to every generated `events.ndjson`) holds:

- `totals`: deliveries, invalid (count and by reason), duplicate deliveries, duplicate conflicts,
  corrections, superseded originals, applied events.
- `apps.<appId>.entities.<kind>`: totals, status counts (`open`/`paused`/`closed`), terminal
  outcome counts, reopened entities, summed paused time, entities with parallel stages, peak
  concurrent children per parent.
- `apps.<appId>.stages."<kind>/<stage>"`: entered/exited/open counts, stage outcome counts, **dwell**
  (closed: count, sum, min, max, p50, p95; open: measured at `asOf`).
- `entities` (only with `--detail`): the full per-entity record.

The generator computes this from its own simulation, independent of the reducer; `validate`
re-derives it from the delivered events and diffs the two. The hand-built scenarios in
`fixtures/scenarios/` carry expectations written by hand rather than derived.

## Generate

```bash
node cli.mjs generate --seed <s> --size <1k|100k|1m|N> [--out <dir>] [options]
```

| Option                        | Default         | Notes                                                                                                                                                                                                        |
| ----------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--seed`                      | required        | Same flags, same bytes.                                                                                                                                                                                      |
| `--size` / `--events`         | `1k`            | Approximate number of lifecycle events before delivery noise; generation stops at the first whole entity tree past it. Deliveries are about 5-30% more (noise adds duplicates, corrections, invalid events). |
| `--profile`                   | `default`       | `clean` (prompt, valid, no noise), `default`, `hostile` (more late/duplicate/corrected/invalid).                                                                                                             |
| `--apps`                      | 3 apps          | `app_a=recruiting,app_b=service_delivery+incident_response`.                                                                                                                                                 |
| `--id-seed`, `--distinct-ids` | shared          | By default apps share an id stream so ids collide across apps. `--distinct-ids` removes that.                                                                                                                |
| `--span-days`, `--start`      | 120, 2026-01-05 | Observation window; `asOf` is its end. Arrivals skew recent so some work is always young.                                                                                                                    |
| `--detail`                    | off             | Add per-entity ground truth to `expected.json`.                                                                                                                                                              |

Outputs `events.ndjson`, `expected.json` and `manifest.json` (parameters, counts, SHA-256 of the
events). Measured on a laptop with Node 24:

| Size   | Deliveries | `events.ndjson` | Generate | Validate | Peak memory |
| ------ | ---------- | --------------- | -------- | -------- | ----------- |
| `1k`   | ~1.3k      | 0.4 MB          | <0.1 s   | <0.1 s   | ~65 MB      |
| `100k` | ~104k      | 35 MB           | ~0.6 s   | ~2 s     | ~0.4 GB     |
| `1m`   | ~1.04M     | 355 MB          | ~6 s     | ~8 s     | ~1.7 GB     |

```bash
node cli.mjs generate --seed 7 --size 1m --out out/seed7-1m   # not committed
```

## Validate

```bash
node cli.mjs validate out/seed7-1m                         # events.ndjson + expected.json in a directory
node cli.mjs validate path/to/events.ndjson --expected path/to/expected.json
node cli.mjs validate out/seed7-1k --scope --coverage      # also prove app isolation and list uncovered behaviours
node cli.mjs validate fixtures/scenarios/recruiting-pipeline.json
node cli.mjs validate --fixtures                           # all committed scenarios + golden digest
```

Exit status is 0 on PASS, 1 on any failed check, 2 on bad usage. It checks the delivery file is in
delivery order, runs the baseline invariants, and diffs the reduction against `expected.json`.
Without an `expected.json` it still checks the invariants.

`validate` can point at any `events.ndjson`, so another workstream's output can be checked against
the same invariants.

## Scenarios (small, readable, hand-checked)

[`fixtures/scenarios/*.json`](fixtures/scenarios) each hold `records` plus a hand-written
`expected`. They are built by [`lib/scenarios.mjs`](lib/scenarios.mjs); regenerate with
`node cli.mjs fixtures --write` (also formats them with the repo's biome) and verify with
`node cli.mjs fixtures --check`.

| Scenario                                         | Shows                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------ |
| `recruiting-pipeline`                            | Need to hire; hired, rejected and withdrawn candidates; concurrent assessments |
| `recruiting-pending-and-cancelled`               | Pending approval, rejected need, cancellation cascading down a subtree         |
| `recruiting-repeat-assessment-delayed-scorecard` | No-show retaken as attempt 2 (`supersedes`); scorecard nine days late          |
| `recruiting-paused-reopened`                     | 20-day pause inside a stage, close, reopen, close again                        |
| `service-regional-rollouts`                      | Three simultaneous regional rollouts: succeed, fail, roll back                 |
| `incident-remediation-reopen`                    | Parallel investigations, remediation, parallel comms stage, reopen             |
| `incident-long-dwell-open`                       | Tickets 40-45 days in a stage at `asOf`; one paused for 30 days                |
| `delivery-out-of-order-and-late`                 | One history delivered scrambled and days late                                  |
| `duplicates-and-corrections`                     | Redeliveries; three corrections, one delivered before its target               |
| `duplicate-id-conflict`                          | Same id, different payload (first wins; an [assumption](#assumptions))         |
| `invalid-events`                                 | One event per invalid reason, all rejected, no effect on state                 |
| `app-scope-separation`                           | Two apps reuse identical ids; nothing collides                                 |
| `broken-state-machine`                           | Negative case: the validator must report each violation                        |

## Late ingestion simulation

```bash
node cli.mjs simulate out/seed7-100k/events.ndjson --late-after 1h --checkpoints 6
```

Reports delivery lag (p50/p95/p99/max of `receivedAt - occurredAt`), the number of late events,
and out-of-order deliveries (an event delivered after a higher version of the same entity). Then,
for evenly spaced checkpoints `T`, it compares what a consumer would know by delivery
(`receivedAt <= T`) against what had happened by occurrence (`occurredAt <= T`): events still in
flight, entities and closures known versus actual, and entities with version gaps. The last
checkpoint must converge (nothing in flight, equal counts), otherwise it exits non-zero. It also
prints the app-scope report: ids reused across apps, and whether each app reduces identically
when its records are processed alone.

Note the long tail on `max` lag: when a whole entity history arrives newest-first, its earliest
event is as late as the entity is old.

## HTTP producer (optional)

```bash
node produce-http.mjs out/seed7-1k/events.ndjson --app app_talent --limit 200            # dry run
FLIGHTDECK_LIFECYCLE_BASE_URL=https://<test-host> \
FLIGHTDECK_LIFECYCLE_TEST_ONLY_TOKEN=TEST_ONLY_<random> \
  node produce-http.mjs out/seed7-1k/events.ndjson --app app_talent --limit 200 --send
```

It POSTs `{ "events": [...] }` (at most 50 per request) to `<base>/v1/lifecycle/events` with
`Authorization: Bearer <token>`.

- **Dry run by default.** Nothing is sent without `--send`.
- **TEST_ONLY credentials only.** The token comes from `FLIGHTDECK_LIFECYCLE_TEST_ONLY_TOKEN`,
  never argv or a file, and must start with `TEST_ONLY_`; anything else is refused, so a
  production key cannot be used by accident. It is never printed. The base URL must be https
  (http only for localhost). Redirects are not followed.
- **It never claims the endpoint works.** If `/v1/lifecycle/events` answers 404/405/501 it prints
  `ENDPOINT NOT AVAILABLE`, ingests nothing and exits 3. A 2xx is reported only as "the endpoint
  answered 2xx"; whether the events were _interpreted correctly_ is for you to check against
  `expected.json`.
- Events are filtered to `--app` and `appId` is stripped (the credential selects the app, as with
  `/v1/server/events`); `--include-app-id` keeps it. Invalid events are skipped unless
  `--include-invalid`, which is how to test the server's rejection path. 503s and network errors
  are retried with bounded backoff and unchanged event ids.

Exit codes: 0 sent (or dry run), 1 failure, 2 usage/safety refusal, 3 endpoint absent.

## Assumptions

- **The envelope is this directory's own contract.** The production `/v1/lifecycle/events` schema
  belongs to the typed-events workstream (FLIG-19) and had not merged when this was written. When
  it lands, adapt `lib/model.mjs` and `lib/builder.mjs` (event shape) and re-run
  `node cli.mjs fixtures --write`; the processes, scenarios and expectations are independent of
  the wire format. Until then the producer's success only means "the endpoint answered".
- First-delivery-wins on a conflicting `(appId, eventId)` reuse is a fixture decision, isolated in
  the `duplicate-id-conflict` scenario.
- `occurredAt` may be later than `receivedAt` for a deliberately wrong original that a correction
  replaces (clock skew); the validator does not reject that.
- Dwell is wall-clock time in a stage, including paused time. Paused time is reported separately.

## Reproducing everything

```bash
cd examples/lifecycle-fixtures
node --test "test/*.test.mjs"
node cli.mjs fixtures --check
node cli.mjs generate --seed ci --size 100k --out out/ci-100k
node cli.mjs validate out/ci-100k --scope --coverage
node cli.mjs simulate out/ci-100k/events.ndjson
```

`fixtures/golden.json` pins the SHA-256 of the 1k `seed 7` events and truth, so any change to the
generator's output fails `validate --fixtures` until you review it and re-run
`node cli.mjs fixtures --write`. CI runs the same commands from
`.github/workflows/lifecycle-fixtures.yml` when this directory changes.

## Layout

```
cli.mjs               generate | validate | simulate | fixtures
produce-http.mjs      optional HTTP producer
lib/processes.mjs     the three process definitions
lib/model.mjs         envelope + validateEvent + invalid reasons
lib/builder.mjs       event construction + the simulation's own record of each entity
lib/generate.mjs      tree walker + delivery layer (late, duplicates, corrections, invalid)
lib/reduce.mjs        reference reducer + ground-truth summary
lib/simulate.mjs      delivery lag, checkpoints, app scope report
lib/scenarios.mjs     hand-built scenarios with hand-written expectations
fixtures/             committed scenarios + golden digest
test/                 node:test suites
```

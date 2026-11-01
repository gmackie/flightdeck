# 10 Instrumentation, SDK, CLI and agent (MCP) access

## 10.1 Producer pattern: the transactional outbox

Lifecycle events describe state changes that already happened in the producer's database, so they
must be emitted **from** that database, not alongside it:

1. In the same transaction that changes the case (an application moves to `screen`), insert an
   outbox row: `(outbox_id, process_id, case_id, event JSON, created_at, sent_at NULL)`.
2. A relay (cron, queue consumer or Durable Object alarm) reads unsent rows in `outbox_id` order and
   sends them in batches of ≤ 100 events and ≤ 10 cases, with `eventId = stable(outbox_id)` and
   `sourceSequence = outbox_id`.
3. On 200, mark the rows sent. On 503 or a network error, back off (1 s, 2 s, 4 s … up to 5 min) and
   resend **the same rows with the same ids**. On 400, move the failing `index` to a quarantine table,
   alert, and continue with the rest.
4. **Backfill** is the same relay over historical rows, with `source: "<system>-backfill"`, and the
   true `occurredAt` (D3 keeps it).

This is the same contract `docs/operations/server-ingestion.md` gives Bob for analytics events
("Retry network/503 failures with bounded exponential backoff and unchanged event IDs"), applied to
lifecycles.

## 10.2 SDK helper (proposed, `@flightdeckhq/worker`)

A thin, typed builder over A's `LifecycleRpc` methods. It never decides business state; it just
makes correct events easy and incorrect ones hard.

```ts
import { lifecycle } from "@flightdeckhq/worker";

const deploys = lifecycle(env.FLIGHTDECK, {
  processId: "delivery.deploy",
  processVersion: 1,
  source: "forgegraph",
  // Producer-held key: caseRef() returns HMAC-based opaque ids (06 §6.2).
  idKey: env.LIFECYCLE_ID_KEY,
});

const caseId = await deploys.caseRef("deploy", changesetId);      // "dpl_3c91e0…"
await deploys.send([
  deploys.caseCreated(caseId, { at: mergedAt, seq: outboxId, dimensions: { env: "production" } }),
  deploys.stageEntered(caseId, "build", { instance: 1, at: buildStart, seq: outboxId + 1 }),
]);
```

| Helper | Produces |
|---|---|
| `caseRef(prefix, sourceId)` | `prefix_` + base32(HMAC-SHA256(idKey, sourceId))[:12] |
| `eventId(sourceId)` | base64url(SHA-256(source + sourceId))[:22], stable across retries |
| `caseCreated/Started/Paused/Resumed/Completed/Terminated/Reopened` | case transitions |
| `stageEntered/Exited/Skipped(caseId, stageId, { instance })` | `stageInstanceId = ${caseId}.${stageId}.${instance}` |
| `blocked/unblocked(caseId, stageId, instance, reason)` | `reason` required (03 §3.3) |
| `link/unlink`, `parent(caseType, parentCaseId)` | relations |
| `retract(eventId)`, `amend(eventId, { at?, dimensions? })` | `event.corrected` |
| `validate(events, definition)` | A's `checkAgainstDefinition` locally, before enqueueing |
| `send(events)` | `ingestLifecycleBatch`, splitting into ≤ 100 events / ≤ 10 cases; throws `LifecycleRejected` (permanent) or `LifecycleRetryable` |

The helper is server-only. The browser SDK gets nothing: browsers are never lifecycle producers.

## 10.3 CLI (proposed, `@flightdeckhq/create` → `create-flightdeck li …`)

Same auth as `apps` (Access service token or `cloudflared`; `packages/create-flightdeck/src/auth.ts`).

| Command | Role needed | What it does |
|---|---|---|
| `li definitions validate <file>` | none (local) | Schema, publish rules (05 §5.2), the sensitive and protected-characteristic denylists |
| `li definitions publish <file> --app <app>` | owner | `POST /li/definitions`; prints the comparability classes against the previous version |
| `li definitions list|show|deprecate` | reader / owner | |
| `li emit <events.ndjson> --app <app> [--dry-run]` | key with `lifecycle.write` | Validates, then sends in batches; for smoke tests and one-off backfills from files |
| `li keys add <app>` | admin | Mints a server key with scope `lifecycle.write` (A's migration), like `apps key` |
| `li cases <process> [--open] [--stage s]` | analyst | Lists cases |
| `li case <process> <case>` | analyst | Prints a timeline with the five-part decomposition |
| `li flow|stages|wip|funnel <process> [--from --to --json]` | reader | API reads with `meta` printed as a footer |
| `li doctor --app <app>` | owner | Capability, key scopes, definitions, recent rejects, lag, reconcile status, diagnostics by code, Basin access |
| `li replay --app <app> [--process p] [--since t] --mode verify|merge|rebuild` | owner/admin | Starts and follows a replay job (07 §7.2) |
| `li reconcile --app <app> --hour 2026-10-09T14` | owner | Runs reconciliation for one hour now |
| `li erase --app <app> --process p --case c…` | admin | Erasure request (06 §6.6) |
| `li export-case --app <app> --process p --case c` | owner | Dumps the CaseDO log as NDJSON (for incident forensics) |
| `li scorecards|alerts list|show|apply <file>` | reader / owner | |

Every command supports `--json`. Exit codes: 0 ok, 1 usage, 2 permanent rejection, 3 retryable
failure.

## 10.4 Agent skill (proposed `skills/flightdeck-instrument-lifecycle`)

A sibling of the existing skills (`skills/README.md`). It teaches an agent to:

1. Find the system of record and its state-change points in the producer repo.
2. Draft a definition with canonical ids and `sensitivity`; run `li definitions validate`.
3. Add an outbox table and relay with stable ids (10.1), using the SDK helper.
4. Map each state change to a transition; add blocks with reasons and pauses only where the
   producer actually records them. **Never infer** blocks from silence.
5. Run the PII check (`skills/flightdeck-instrument-worker/scripts/pii-check.sh`, extended with the
   protected-characteristic list) on the diff.
6. Verify with `li emit --dry-run`, then `li case` on a staging case.

## 10.5 Read-only MCP for agents (D14)

### Shape

- Route `POST /mcp` on the Flightdeck Worker (Streamable HTTP), behind the same Access application.
  An agent authenticates with an Access service token (`common_name` principal), or a person's
  token through `cloudflared`.
- **Tools and resources are thin wrappers over the HTTP API**: they call the same handlers in
  process, so authorization (E), suppression, envelope and audit are identical. There is no
  separate query path.
- **Read-only by construction**: the server registers no tool whose handler is not a `GET` handler.
  A test enumerates tools and fails if any maps to a mutating route (12).
- Output caps: 50 rows per list, 64 KiB per result; truncation is explicit (`truncated: true`,
  `next_cursor`).
- Service tokens hold at most `reader` on one app (E's SQL constraint), so by default agents see
  aggregates of standard processes only. Restricted processes are invisible to service tokens
  (06 §6.4).

### Resources

| URI | Content |
|---|---|
| `flightdeck://apps/{app}/li/processes` | Processes with versions, sensitivity and stage lists |
| `flightdeck://apps/{app}/li/processes/{process}/definitions/{version}` | Definition JSON |
| `flightdeck://li/metrics` | The metric catalog (09 §9.1) with definitions and directions |
| `flightdeck://li/semantics` | A condensed version of 04, so an agent explains numbers correctly |

### Tools

| Tool | Input | Wraps | Min role |
|---|---|---|---|
| `li_list_processes` | `{ app }` | `GET /processes` | reader |
| `li_flow` | `{ app, process, from?, to?, cohort?, versions?, breakdown? }` | `/flow` | reader |
| `li_stage_dwell` | `{ app, process, from?, to?, visits? }` | `/stages` | reader |
| `li_funnel` | `{ app, process, from?, to?, within_days? }` | `/funnel` | reader |
| `li_wip` | `{ app, process }` | `/wip` | reader |
| `li_throughput` | `{ app, process, bucket, from?, to? }` | `/throughput` | reader |
| `li_scorecard` | `{ app, scorecard }` | `/scorecards/:id` | reader |
| `li_freshness` | `{ app, process }` | `meta.freshness` + `/health` summary | reader |
| `li_diagnostics` | `{ app, process?, code? }` | `/diagnostics` | reader (counts) / analyst (ids) |
| `li_case_timeline` | `{ app, process, case }` | `/cases/:case` | person `analyst`; never for service tokens |
| `li_explain_metric` | `{ metric }` | catalog lookup | none beyond auth |

Every tool result includes the full `meta` (08 §8.3), and the tool descriptions tell the agent to
quote `n`, `as_of` and `comparability` whenever it reports a number. Because the contract has no
free text (codes only), tool output can't carry injected instructions from producers (S6).

### Reuse from old PR #8

Old draft PR #8 ("Optional read-only MCP server for trusted coding agents", stacked on the obsolete
branch chain) had good principles: no write tools, response truncation, strict denial without
Access, and an explicit note that OAuth for third-party clients wasn't implemented. This RFC keeps
those principles and drops its code: it was a separate Worker that forwarded to a console service
from the old architecture, which doesn't exist on `main`. See Appendix A.

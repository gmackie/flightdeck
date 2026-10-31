# @flightdeckhq/lifecycle

A dependency-free TypeScript/ESM engine for object-centric lifecycle process intelligence.
The same API describes hiring applications, service rollouts, incidents, and other processes.
There are no built-in stages, business outcomes, domain object types or ingestion dependencies.

This package is standalone WORKSTREAM B. It does not change Flightdeck's shared event schema,
SDK ingestion, persistence or dashboards. An adapter can map any authoritative event source
into these inputs later. See [`test/fixtures.ts`](test/fixtures.ts) for executable hiring,
rollout and incident fixtures and [`test/`](test/) for edge cases.

## Usage

```ts
import {
  id,
  replay,
  stageMetrics,
  caseMetrics,
  summarize,
  funnel,
  type LifecycleEvent,
  type ReplayInput,
} from "@flightdeckhq/lifecycle";

// Persist opaque IDs from the owning system. Do not generate IDs from labels or event order.
const processId = id<"process">("proc_7:v1");
const caseId = id<"case">("case_93");
const stageId = id<"stage">("stage_2");
const attemptId = id<"stage-instance">("attempt_8");
const events: LifecycleEvent[] = [
  {
    id: id<"event">("e1"),
    occurredAt: 0,
    source: { id: "system", sequence: 1 },
    type: "case.start",
    caseId,
  },
  {
    id: id<"event">("e2"),
    occurredAt: 10,
    source: { id: "system", sequence: 2 },
    type: "stage.enter",
    stageInstanceId: attemptId,
  },
];
const input: ReplayInput = {
  definitions: [{ id: processId, stages: [{ id: stageId, label: "Review" }] }],
  cases: [{ id: caseId, processId, attributes: { region: "east" } }],
  stageInstances: [{ id: attemptId, caseId, stageId }],
  events,
  reliableSources: ["system"],
  asOf: 100,
};
const initial = replay(input);
stageMetrics(initial, attemptId); // wallClockMs=90, activeAgeMs=90, openCensored=true
caseMetrics(initial, caseId); // explicit parent openDurationMs=100
summarize(initial, { processId, attributes: { region: "east" } });
funnel(initial, [stageId], { denominator: "all-reached" });

// A late exit arrived after the original replay. Append to the LOG, then replay the full log.
const late: LifecycleEvent = {
  id: id<"event">("e3"),
  occurredAt: 70,
  source: { id: "system", sequence: 3 },
  type: "stage.exit",
  stageInstanceId: attemptId,
};
const withLate = replay({ ...input, events: [...events, late] });
stageMetrics(withLate, attemptId).wallClockMs; // 60

// An authoritative correction replaces e3's occurrence. Receipt order is irrelevant.
const correction: LifecycleEvent = {
  id: id<"event">("e4"),
  occurredAt: 60,
  source: { id: "system", sequence: 4 },
  type: "stage.exit",
  stageInstanceId: attemptId,
  supersedes: late.id,
};
const corrected = replay({ ...input, events: [...events, late, correction] });
stageMetrics(corrected, attemptId).wallClockMs; // 50
// The effective timeline omits e3; supersededEventIds contains e3.
// Future corrections target e4, creating a linear chain.
```

All times and durations are Unix milliseconds and elapsed milliseconds, respectively.
Epoch zero is valid. Pre-1970 timestamps are valid; a negative **duration** is not.
`asOf` is required: the engine never reads the wall clock or generates random IDs.

## Public contract

- `ProcessDefinition`: immutable version ID, stage definitions, optional initial stage IDs and
  allowed predecessor edges. Version a definition with a new ID when semantics change.
  With nonempty `transitions`, a stage can enter if any explicitly closed prior instance in
  that case has an allowed edge; the first entry requires `initialStages`. This is an observed
  predecessor rule, not a Petri net or exclusive single-stage workflow. Definition cycles and
  self edges intentionally permit loops/retries; they are not invalid hierarchy cycles.
- `CaseInput`: stable case ID, process version ID and optional cohort attributes.
- `StageInstanceInput`: stable attempt ID, case ID and stage ID. Parallel and repeated stages
  use distinct instance IDs, even when their stage ID is the same. Reusing a closed instance
  ID for entry is invalid. There is no inferred retry count or HR-specific identity.
- `LifecycleEvent`: globally unique event ID, authoritative `occurredAt`, source ID, optional
  sequence, optional `supersedes`, and a discriminated event payload.
- `replay(ReplayInput)`: returns cases, stage instances, relation/child link histories,
  observed visits, effective events, superseded IDs and structured diagnostics. Inputs are
  not mutated. Replaying the same log, permuting arrival order, or inserting exact duplicates
  gives the same result. Reconstruct from the full log after each late insertion/correction.
- `stageMetrics`, `caseMetrics`, `unionDuration`, `percentile`, `ratio`, `selectCases`, `funnel`,
  `variants` and `summarize` are exported alongside their public input/output types.

Events supported:

| Events                                                        | Meaning                                                                                         |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `case.start`, `case.pause`, `case.resume`                     | Explicit case opening and interruption windows                                                  |
| `case.terminate`                                              | Explicit terminal class: `completed`, `rejected`, `withdrawn`, `cancelled`, `failed`, `expired` |
| `case.reopen`                                                 | Requires termination; starts a new explicit episode and clears the current terminal class       |
| `stage.enter`, `stage.exit`, `stage.skip`                     | Observe attempt boundaries or explicit skip; skip is never zero dwell or completion             |
| `stage.block`, `stage.unblock`, `stage.pause`, `stage.resume` | Match independent interruption IDs; concurrent reasons can overlap                              |
| `relation.link`, `relation.unlink`                            | Opaque relation ID and arbitrary typed object endpoints; retain link/unlink/relink windows      |
| `child.link`, `child.unlink`                                  | Case-to-case hierarchy windows; many children and many parents allowed, active cycles rejected  |
| `event.retract`                                               | Supersede a bad event without applying a replacement action                                     |

A relation ID's kind and endpoints cannot change. Use another ID to describe another relation.
Relations are many-to-many and need not reference cataloged cases (external objects remain
opaque). For `relatedObject` cohort filters, the case endpoint explicitly uses `type: "case"`.
Child links require both cases in the case catalog; cycles are checked against **active links**,
so reversing a relationship after an explicit unlink is valid. Children need not use the same
process definition. Stages and children can overlap freely; parent termination does not invent
child terminations or stage exits.

## Ordering, duplicates and corrections

1. Deduplicate by globally unique event ID and canonical payload equality (object key order
   does not matter). Conflicting payloads with the same ID are all excluded and diagnosed.
   Catalog conflicts are likewise excluded rather than choosing an arrival-order winner.
2. Resolve correction chains over the entire supplied log. A replacement supersedes one
   event and uses its own occurrence time. Competing replacements are excluded and the
   original remains; missing targets and cycles are diagnosed. Corrections depending on
   invalid corrections are excluded. Retractions remove evidence; they never infer outcomes.
3. Apply effective events at/before `asOf`, ordered first by occurrence time, then source ID,
   then source sequence for sources explicitly listed in `reliableSources`, then event ID.
   Sequence only orders equal timestamps within the same reliable source. Missing sequences
   sort after supplied sequences. Repeated/backward reliable sequences produce
   `sequence_time_conflict`; occurrence time takes precedence, never silently overridden.
4. Equal timestamps without distinct sequences from a common reliable source produce an
   `ambiguous_order` diagnostic. Source/event IDs give stable fallback order, **not evidence
   of causality**. Funnel matching treats equal-time entries as an unordered group; variant
   keys do too. Cross-source clock skew is not automatically corrected.

`asOf` is an occurrence-time cutoff with **current knowledge from the supplied log**. It is
not a historical receipt/knowledge-time query: a correction in the supplied log applies even
if its metadata was learned later. For “what did we know then?” pass a receipt-time-filtered
log yourself. There is no ingestion/receipt timestamp hidden in this API.

## Unknown and incomplete data

`null` means unknown; `0` is reserved for a known empty interval/count. An unobserved case or
stage is `unknown`. An exit without entry retains its explicit end but has unknown dwell.
Termination without start retains the explicit outcome with unknown duration. An open stage
in a terminated case has an unknown exit; the engine does not close, reject, cancel or revive
it on your behalf. Missing interruptions and invalid transitions poison availability rather
than pretending unavailable time is zero. Corrupt excluded interruption events also make
availability unknown. Explicitly skipped attempts have unknown dwell, separately counted skips.

The engine detects structural gaps; it cannot detect an event that disappeared without any
trace. Set `historyComplete: false` on a case or instance when the source extraction is known
partial. Treat diagnostics as data quality evidence. Counts and observed paths describe the
supplied log, not proof that every real-world action has been captured. Unknown/inconsistent
cases are counted separately from complete observed variants. A genuine observed start=end
has zero duration; no zero is substituted for missing timestamps.

## Metric definitions

| Metric                     | Definition                                                                                   |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| Stage `wallClockMs`        | Explicit entry → exit; for an open stage in an open case, entry → `asOf`                     |
| Stage `blockedMs`          | Union of blocked windows, clipped to that instance's observed bounds                         |
| Stage `pausedMs`           | Union of stage and case pauses, clipped to the instance bounds                               |
| Stage `unavailableMs`      | Union of **both** blocked and paused windows, not their sum                                  |
| Stage `availableElapsedMs` | Wall clock − unavailable union; never claimed as hands-on labor                              |
| Stage `activeAgeMs`        | Available elapsed time for an open censored attempt, otherwise `null`                        |
| Case `spanMs`              | First explicit start → last explicit end or `asOf`, including closed gaps between reopenings |
| Case `openDurationMs`      | Union of explicit open episodes, excluding closed gaps                                       |
| Case `pausedMs`            | Union of case pauses within open episodes; explicit termination bounds case pauses           |
| Case `availableElapsedMs`  | Open duration − case pause union; never a labor measurement                                  |
| Case `childOverlapMs`      | Union of child open episodes ∩ explicit link windows ∩ explicit parent episodes              |
| Case `parallelChildMs`     | Parent time with at least two **distinct** direct children open; never sum child durations   |

Parent duration uses explicit parent timestamps exclusively. Child overlap is direct-child
coverage, not recursive descendant effort. Incomplete child/link boundaries make overlap
unknown while leaving a supported explicit parent duration intact. Open intervals extend to
`asOf`, clipped to known exit/episode boundaries. Overlap/adjacency union is deterministic.

`percentile(samples, q)` linearly interpolates at `(n − 1) × q`; p50 and p90 use q=.5 and .9.
Empty distributions yield `null` percentiles. Invalid negative/nonfinite duration samples
throw. `summarize` uses only closed cases with known open duration and closed stage instances
with known dwell for distributions, returning sample sizes, open censor counts, unknown and
skip counts. It does not treat open ages as completed dwell or implement survival analysis.
`completionRatio = explicitly completed cases / explicitly terminated cases` (all six outcomes
in the denominator); a zero denominator is `null`. `ratio` returns `null` on zero denominator.

`funnel(result, [stageA, stageB, ...])` matches case-level nondecreasing-time entry subsequences.
Retries do not multiply a case's reached/converted counts. Skips do not count as entries.
At each step, `reached` is the cases matching that prefix and `converted` is those also matching
the next prefix. Equal-time groups can match either requested order without claiming causality.
`all-reached` (default) uses all reached cases, **including open censored cases**, in the
conversion denominator. `closed-only` uses only explicitly terminated reached cases for both
ratio numerator and denominator. The raw `converted` count remains all reached conversions.
Both policies expose the open censor and incomplete counts. Last-step conversion and empty
ratios are `null`. These are observed conversion ratios, not eventual conversion predictions.

Cohorts support process version, first explicit start in `[startedFrom, startedBefore)`, exact
attributes, current status, current explicit terminal class and currently linked objects.
Missing starts fail date filters. Attributes are static supplied case attributes, not historical
attribute changes. Variants group process version + equal-time stage-entry groups + current
terminal/status; repeated instances remain repeated entries, with counts/shares and open censor
counts. They are observed traces, not full process conformance or concurrency inference from
interval overlap. Explicit skips, case pauses and reopen actions remain in effective events but
are not separate variant tokens. Incomplete cases are excluded from variant shares and counted.

## Limits and checks

The API accepts typed, normalized inputs; it is not a wire-format validator or storage adapter.
Finite timestamps, sequences, duplicate identities, references and transitions are checked, but
untyped JSON must be validated by the caller. It does not provide persistence, streaming
incremental replay, calendars/business hours, timezone normalization, survival estimates,
causal discovery, source clock reconciliation or inferred missing actions. Full-log replay and
some metrics scan the supplied batch repeatedly; large-volume indexing belongs in an adapter.
No dependency on `@flightdeckhq/schema` is introduced.

The existing `packages/*` workspace, recursive build/typecheck/versioning/pack scripts and root
Vitest projects discover this package automatically. Development exports point at source;
packed exports point at emitted JS/declarations using `.js` imports for plain Node ESM.

```sh
pnpm test --project lifecycle
pnpm --filter @flightdeckhq/lifecycle typecheck
pnpm --filter @flightdeckhq/lifecycle build
pnpm test
pnpm typecheck
pnpm lint
pnpm smoke:pack
```

## Workstream A adapter boundary

`normalizeCanonicalTransition(type, engineEnvelope, context)` is an explicit, tested transition
adapter for A's `packages/schema/src/lifecycle.ts` vocabulary. It has **no import or dependency**
on that package. It returns `{ event, diagnostic: null }` or `{ event: null, diagnostic }`;
unknown names and unsupported operations fail explicitly. Direct `replay` also diagnoses
unrecognized names as `unsupported_event`, rather than silently accepting past-tense wire names.

| A canonical transition                             | Engine action / required context                                                       |
| -------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `case.started` / `case.reopened`                   | `case.start` / `case.reopen`; mapped `caseId`                                          |
| `case.paused` / `case.resumed`                     | `case.pause` / `case.resume`; mapped `caseId`, explicit matched `interruptionId`       |
| `case.completed`                                   | `case.terminate` with `terminal: "completed"`                                          |
| `case.terminated`                                  | `case.terminate`; **requires** explicit authoritative `terminal` context               |
| `stage.entered` / `stage.exited` / `stage.skipped` | `stage.enter` / `stage.exit` / `stage.skip`; mapped `stageInstanceId`                  |
| `stage.blocked` / `stage.unblocked`                | `stage.block` / `stage.unblock`; instance ID + explicit matched interruption ID        |
| `stage.paused` / `stage.resumed`                   | `stage.pause` / `stage.resume`; instance ID + explicit matched interruption ID         |
| `object.linked` / `object.unlinked`                | `relation.link` / `relation.unlink`; explicit stable relation identity and endpoints   |
| `case.created`                                     | Catalog creation evidence only; adapter returns unsupported, never substitutes a start |
| `event.corrected`                                  | Resolve the correction target explicitly as below; adapter returns unsupported         |

A currently carries `eventId`, `processId`, `processVersion`, `caseId`, `sourceSequence`, optional
`source`, stage/object fields, `reason`, `dimensions`, `relations` and correction payloads.
The envelope/catalog adapter must deliberately map these before transition normalization:

- Scope event IDs to the app (A deduplicates by app + event ID). Scope case IDs to the app and
  stage-instance IDs to the owning case; preserve the same mapping for correction targets.
  Collision-free JSON tuples or persisted opaque lookup IDs work; do not join raw IDs with
  ambiguous delimiters. Definition IDs must include A's `processId` **and** `processVersion`.
- Copy `occurredAt` unchanged. A's `sourceSequence` is **per case**, so `source.id` in this
  engine must represent `(app, source, case)`, not just the source name. List these scoped
  source IDs in `reliableSources` only when the producer guarantees sequence reliability.
- A does not currently encode a terminal class on `case.terminated`. Require authoritative
  context or a configured, explicit reason-code→class mapping; absent evidence is unknown.
  Do not equate every termination to rejection, cancellation or failure.
- A has a reason code but no interruption identity. Supply a stable matched ID from source
  evidence. A configured single-open-interruption convention can be used only when the
  producer guarantees it; overlapping reasons cannot be paired by guessing an end reason.
- A object events have no relation ID/kind. Supply a stable link identity/kind and map
  `{type, objectId}` to `{type, id}` endpoints. Stage-scoped objects use a stage-instance
  endpoint. `relations` metadata is not an implicit set of link/unlink events. A has no
  dedicated child-process transition; create `child.link/unlink` only from explicit,
  authoritative parent/child semantics, not from every arbitrary object association.
- For A's `event.corrected` with `action: "retract"`, emit `event.retract` with the scoped
  target ID in `supersedes`. For `action: "amend"`, load the target, retain its **action and
  subject IDs**, apply the supplied corrected occurrence time, and emit a new engine event
  using the correction's ID and `supersedes: targetId`. An amendment without a timestamp
  retains the target time. Resolve chains by IDs, not arrival order; a missing target is
  unknown/quarantined. A dimension amendment must be resolved by the adapter before building
  case cohort attributes; this engine does not silently turn event dimensions into static
  case attributes. The late-exit/supersession example above demonstrates normalized replay.

```ts
import { id, normalizeCanonicalTransition } from "@flightdeckhq/lifecycle";

// Example of an already A-validated wire event. A validation stays in the ingestion layer.
const wire = {
  eventId: "event_0001",
  type: "case.started",
  occurredAt: 1_800_000_000_000,
  caseId: "case_93",
  source: "outbox",
  sourceSequence: 1,
};
const scope = "app_42";
const scopedCase = id<"case">(JSON.stringify([scope, wire.caseId]));
const normalized = normalizeCanonicalTransition(
  wire.type,
  {
    id: id<"event">(JSON.stringify([scope, wire.eventId])),
    occurredAt: wire.occurredAt,
    source: {
      id: JSON.stringify([scope, wire.source, wire.caseId]),
      sequence: wire.sourceSequence,
    },
  },
  { caseId: scopedCase },
);
if (normalized.event === null) throw new Error(normalized.diagnostic.message);
// Add normalized.event to the replay log, with a correspondingly scoped case catalog.
```

When an adapter cannot supply required context, retain its diagnostic and mark the affected
case/instance `historyComplete: false`; dropping an unsupported wire event must not produce a
claim that the history is complete. `test/normalize.test.ts` checks canonical start/entry/exit/
completion replay equivalence, interruption overlap, explicit terminal/identity requirements,
object normalization and rejection of incompatible names. The canonical schema is still
owned by A; this mapping records the inspected contract without editing its files.

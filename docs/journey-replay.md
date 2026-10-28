# Object-centric journey replay

Flightdeck journeys are versioned, deterministic state machines compiled from approved definitions. The model is intentionally simple: named states and event-driven transitions. AI can suggest a model but cannot execute arbitrary code or enable it automatically.

## Live execution

The optional Queue consumer routes each canonical accepted event by `projectId + objectType + objectId` to a SQLite-backed Durable Object. Actors may be represented as a synthetic object type `actor` if the event has an authenticated actor ID. The DO maintains a bounded event history, keyed by **source ID and event ID**, and computes state by ordering all events by occurrence time.

Late events can therefore update prior states without silently leaving an inconsistent transition sequence. New definition versions trigger deterministic recomputation rather than inheriting stale state.

## Replay and reconciliation

A replay operation supplies a canonical, bounded set of event records from Basin or another verified source. The DO replaces its local history and recomputes the journey state, recording the replay timestamp and origin.

A replay response proves **only that the supplied records were processed deterministically**. It does not prove that the history is complete. The operator must verify the Basin/Iceberg query bounds, account, project and object scope, and watermark before declaring reconciliation complete.

## Limits

- Default journey windows: 30 days; can be reduced per definition.
- Maximum history per object: 4096 events; high-activity objects require materialized checkpoints and pagination.
- Duplicate retries are idempotent within local history retention.
- Relative ordering uses ISO timestamps; application clocks can be skewed. The ingest validator rejects excessive future drift.
- Queue fan-out is not atomic with canonical Basin writes. Reconciliation is needed after queue failures.
- Unsupported transition types (branching on PII properties, custom code) are intentionally excluded.

The live journey engine does not make causal claims or automatically manipulate Flagship rollouts.

# Flightdeck Journey service binding and object state

The Queue consumer owns per-object SQLite Durable Objects and can be invoked over a separate, **private** Worker service binding for state queries and operator-authorized replay.

### Console service binding

```json
{"services":[{"binding":"JOURNEY_SERVICE","service":"flightdeck-journey"}]}
```

Configure the same randomly generated internal key as a secret named `JOURNEY_INTERNAL_TOKEN` on the Journey Worker and `JOURNEY_INTERNAL_KEY` on the Console Worker. Do not expose it in React assets, query strings, event data or logs.

An Access-authenticated **administrator** may call `GET /api/journey-state?type=project&objectId=...`. The console forwards to `/internal/state` over the private service binding with a project ID derived from its environment. An optional `POST /api/journey-reconcile` operation can forward a bounded canonical history from a verified operator to `/internal/reconcile` after explicit review.

**Do not declare reconciliation complete solely from a 200 response.** It only proves a deterministic replay of supplied records. A real reconciliation workflow must check Basin query watermarks, late-arrival window, object scope and event completeness.

The Durable Object journals up to 4096 observations per object and recomputes a journey from occurrence time when delayed events arrive. It protects against cross-object calls and duplicate retries using a composite source/event ID. Source events outside the 30-day live horizon are not incorporated into this state. Models requiring longer lifetimes need checkpoint materialization.

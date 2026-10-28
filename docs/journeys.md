# Experimental live journey processing

Optional infrastructure (not part of baseline analytics):

```sh
pnpm exec wrangler d1 create flightdeck-meta
# Replace D1 UUID in apps/journey/wrangler.jsonc
pnpm exec wrangler d1 migrations apply flightdeck-meta --remote --config apps/journey/wrangler.jsonc
pnpm exec wrangler queues create flightdeck-journeys
pnpm exec wrangler queues create flightdeck-journeys-dlq
pnpm exec wrangler deploy --config apps/journey/wrangler.jsonc
# Then deploy apps/core with apps/core/wrangler.live.example.jsonc adapted to your stream ID.
```

**Review the account's existing resources and generated configuration first.** The above are guided commands, not an idempotent installer.

D1 `journey_definitions` defines active versioned state machines. For example, `project_id=default`, `object_type=project`, `initial_state=created`, transitions `[{"from":"created","event":"project.opened","to":"active"}]`. Newly inserted definitions default **disabled** until an authorized administrator enables them.

On event stream acceptance, Analytics Core may enqueue each flat record asynchronously. The Queue consumer reads enabled definitions by project/object type, passes records to object-keyed SQLite Durable Objects and acknowledges only after state persistence. The DO records processed event IDs for duplicate retries, ignores out-of-order transitions for its live state, and prunes old dedupe rows.

This path is **best-effort relative to Basin**: Queue delivery and Basin writes are not an atomic transaction. Historical replay/reconciliation, efficient definition caching, D1 owner/admin UI and baseline state migration are still required before general availability.

# Live sessions

Open **Live Sessions** in the Console. Accepted events with valid session IDs update the view automatically, normally within the next two-second refresh. Pause/resume controls preserve the last snapshot. Hidden tabs stop polling and resume immediately when visible. Failures keep the last snapshot, show a reconnecting/error state, and retry; the timestamp identifies stale data.

This view uses a private Core RPC and a project-keyed `LiveSessions` Durable Object. It does not run Basin queries on every refresh and does not wait for historical query visibility. The Console verifies Cloudflare Access JWTs before invoking Core and derives the project from its own configuration, ignoring caller project parameters. Core remains private without a public ingestion or session endpoint.

Core first awaits the authoritative historical sink. Only successful acceptance is projected into live storage. A failed optional projection logs a generic diagnostic and does not change a successful historical receipt. Live state is best effort: sink and projection are separate writes, with no transactional or exactly-once claim. Event retries are deduplicated by source/event identity within the retained window. Delayed events cannot replace a newer last-event timestamp. Historical imports older than the live window do not populate the feed.

The projection retains session, source, environment, actor identity, event name and timestamps only; it never copies event properties or business objects. Sessions are grouped by source/environment/session identity. Storage is bounded to the newest 256 accepted events and 96 KB per project; responses include at most 100 recent sessions. Counts describe the retained sample, not a complete historical session total. Old events expire after 30 minutes by acceptance time; an alarm deletes idle state. Capacity eviction can remove entries sooner. Session activity requires SDK events to carry `sessionId` (browser SDK does this automatically). This feature is activity metadata, not session replay.

## Installation and rollout

Generated Core configs include `LIVE_SESSIONS`, the exported `LiveSessions` class, and the additive `live-sessions-v1` SQLite Durable Object migration. Standard mode includes this feature without enabling journey queues. Deploy Core first, then Console; the API returns 503 if the binding or upgraded Core method is missing. Preserve all existing secrets, D1, stream and Access bindings. Existing account permissions/plan must permit Durable Objects; verify the dry-run before applying to an account.

Run `pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm test:installer`, `pnpm test:integration`, and `node scripts/test-live-runtime.mjs`. The runtime script uses local Worker RPC, SQLite DO and R2 emulation only; it creates no remote resources. Send accepted session-bearing events in a dedicated environment, confirm both apps appear and retries do not inflate counts, and confirm anonymous `/api/live-sessions` requests remain denied.

## Rollback

Revert the Console feature and remove the `LIVE_SESSIONS` binding from Core to disable new projections. Keep the exported `LiveSessions` class and its migration history while instances exist; do not blindly roll back to a version that removes the class. Idle data expires through its alarm. Canonical Basin history is unaffected. If the live projection fails, historical analytics remain the source of truth. Before a wider rollout, measure concurrency, DO latency and cost: this initial implementation serializes a bounded cache per project and is not a high-volume session warehouse.

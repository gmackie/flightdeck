# Basin setup (self-hosted)

1. Create R2 bucket: `pnpm exec wrangler r2 bucket create flightdeck-events`.
2. Enable Basin Catalog: `pnpm exec wrangler basin catalog enable flightdeck-events`.
3. Set up a restricted Catalog + R2 token in Cloudflare.
4. Run `pnpm exec wrangler basin pipelines setup`, select the schema file `basin/events.schema.json` and an Iceberg Catalog sink (namespace `default`, table `flightdeck_events`).
5. Copy its **stream ID** and run `pnpm setup -- --mode basin --stream-id YOUR_STREAM_ID`.
6. Configure the consuming Worker's private service binding and source credentials from `docs/service-bindings.md`.
7. Validate the stream's user-error metrics and query the Iceberg table using Basin SQL.

Important: a stream `send(records)` acknowledgement means the records were ingested, not yet queryable in SQL. Structured stream/schema mismatches can be acknowledged then dropped by the pipeline: test schemas and monitor errors.

R2 direct-write mode (`--mode r2`) is a limited fallback, **not** Iceberg analytics.

Official guides:
- https://developers.cloudflare.com/basin-pipelines/getting-started/
- https://developers.cloudflare.com/basin-pipelines/streams/writing-to-streams/
- https://developers.cloudflare.com/basin-sql/query-data/

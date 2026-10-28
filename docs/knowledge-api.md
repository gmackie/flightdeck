# Product knowledge graph service API

Register architecture metadata **from an authenticated application Worker/DO**:

```ts
await analytics.registerGraph({
  revision: "commit-a12b3c",
  nodes: [
    {id:"route:checkout",kind:"route",label:"Checkout"},
    {id:"api:purchase",kind:"api",label:"POST /purchase"}
  ],
  edges: [
    {from:"route:checkout",to:"api:purchase",relation:"calls",provenance:"source_code"}
  ]
});
```

The calling worker must have a service binding to Flightdeck Core and a source token with `graphEnabled:true`. This method is **not available from the browser SDK**.

The manifest is versioned, bounded, schema-validated, and transactionally projected into the installer's own D1 database. Every source is scoped to a project derived from authenticated context; the browser cannot choose a project or register architecture metadata.

The console's read-only `GET /api/graph` returns up to 200 active nodes and 500 active edges with provenance/confidence for display. Inferred edges require evidence IDs. Inactive nodes from previous complete revisions remain as metadata but are excluded from the active graph view.

Future extensions: source-code location indexing (file/commit/line), OpenAPI ingestion, Effect Schema introspection, runtime span linking, graph history queries and source-specific migration diff views.

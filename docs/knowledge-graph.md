# Flightdeck product knowledge graph

Flightdeck optionally accepts **application architecture manifests** from existing authenticated Workers/DOs via the same private service binding used for analytics.

The manifest describes routes, APIs, components, services, Durable Objects, database entities, business objects, deployments, features, agents and goals. Edges explicitly state their provenance: source code, runtime observation or inference. Inferences require evidence IDs and a bounded confidence value.

A manifest is scoped to the server-authenticated Flightdeck source and project. Browser clients cannot submit architecture manifests. The source must explicitly opt in using `graphEnabled: true` in its registry policy.

This system does **not** parse an entire GitHub repository autonomously. Agents can generate a manifest from permitted source inspection and submit it via the private binding. Graph nodes and edges are stored in D1 metadata, versioned by source revision, with prior entries marked inactive when a complete new manifest arrives.

Avoid attaching customer secrets, emails or private content as node properties. Refer to `@flightdeck/knowledge` for the validated manifest contract and `/api/graph` for a project-scoped, read-only graph view.

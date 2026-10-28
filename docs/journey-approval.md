# Journey definitions and approvals

Flightdeck's optional live journey runtime consumes only **approved, deterministic definitions**.

- `GET /api/journey-definitions` lists versions, transitions and activation status.
- `POST /api/journey-definitions` creates a **disabled** definition after validation.
- `PUT /api/journey-definitions/:id` updates a definition, increments its version and disables it pending review.
- `PATCH /api/journey-definitions/:id` requires an admin and a written rationale to enable a definition.
- `GET /api/journey-state?type=...&objectId=...` allows administrators to inspect one object's live state via private service binding.

Console writes require Cloudflare Access, a configured admin allowlist, same-origin requests and D1 audit history. Object scope/project comes from trusted server configuration. AI cannot activate state machines automatically.

Reconciliation still requires the operator to supply verified canonical records and to check completeness/watermark. The initial internal replay endpoint does not prove data completeness.

# Coding agent guidance

Read docs/architecture.md. Flightdeck is account-owned, separate from Cloudflare Flagship UI. Browser events are untrusted; production collector fails closed without verified source credentials, consent rules, rate limits, and durable storage. Effect schemas are contracts; backend apps use private service bindings. Do not acknowledge unpersisted events as durable or claim exactly-once Queue/Basin writes. AI inference must retain evidence and require validation and approval before acting. Changes need tests, migrations, rollback and deployment docs. Never deploy to real Cloudflare accounts from tests.

## Separate-workspace execution
Stacked PRs must remain unmerged until tests pass in the workspace that owns
the Cloudflare account. Use docs/workspace-handoff.md and docs/release-gates.md.
Never grant coding agents a production account token merely to complete a PR.
Use dry-run installation first and explicit operator approval for remote actions.

## Universal installer invariants

- Workers.dev URLs must be Access protected; Console assets require run_worker_first=true.
- Never publish a public Collector or Core Worker as part of installation.
- Store only source token digests in D1; never persist R2 Catalog or Cloudflare API tokens in manifests.
- Account selection is explicit and installer must refuse untracked name collisions.
- Any remote resource mutation requires operator approval; CI dry-runs are side-effect-free.
- Shared Zero Trust organizations/IdPs must not be overwritten.
- Admin MCP writes are proposals requiring review in the UI; no hidden deployment or shell capability.

## Administrator MCP and UI

Source credentials may be displayed once only to Access-authenticated admins via the Console API; never return them in inventory views or MCP. Admin MCP can propose typed, project-scoped D1 changes, but cannot directly apply or approve changes. Versioned source policy edits, one-time credential rotation, audit and quota governance must be server-enforced.

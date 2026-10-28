# Coding agent guidance

Read docs/architecture.md. Flightdeck is account-owned, separate from Cloudflare Flagship UI. Browser events are untrusted; production collector fails closed without verified source credentials, consent rules, rate limits, and durable storage. Effect schemas are contracts; backend apps use private service bindings. Do not acknowledge unpersisted events as durable or claim exactly-once Queue/Basin writes. AI inference must retain evidence and require validation and approval before acting. Changes need tests, migrations, rollback and deployment docs. Never deploy to real Cloudflare accounts from tests.

## Separate-workspace execution
Stacked PRs must remain unmerged until tests pass in the workspace that owns
the Cloudflare account. Use docs/workspace-handoff.md and docs/release-gates.md.
Never grant coding agents a production account token merely to complete a PR.
Use dry-run installation first and explicit operator approval for remote actions.

# Installer internals

The install wizard is intentionally a CLI first, similar to Coworkers' local installer. It is a deterministic, resumable sequence of resource creations using the user's Cloudflare credentials. The complete installation runs in their account.

Modules:
- `engine.mjs`: validated names, locked 0600 manifest, shell runner, safe subprocess invocation.
- `cloudflare.mjs`: account discovery and namespaced Access/Zero Trust provisioning.
- `basin.mjs`: D1/R2/Basin/Queue resources, API mode or nested Wrangler wizard.
- `config.mjs`: generated Wrangler bindings, first-deploy Access lock, Worker-first static assets.
- `wizard.mjs`: idempotent step orchestration, migrations, secret setup, smoke tests.
- `../install-cloudflare.mjs`: interactive entrypoint.

The goal is first-party Worker/DO ingestion, not a public Flightdeck collector. Keep production secrets outside configs, avoid other accounts' resources, require explicit approval for remote mutations and maintain a separate verified release gate.

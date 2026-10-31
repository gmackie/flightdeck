# Flightdeck agent skills

Skills that let coding agents instrument Cloudflare Worker apps with Flightdeck, one repo per agent, in parallel. Each skill is a directory with a `SKILL.md` (frontmatter `name` + `description`, then instructions) and supporting files under `references/` or `scripts/`.

| Skill | Use it to |
|---|---|
| [`flightdeck-instrument-worker`](flightdeck-instrument-worker/SKILL.md) | Register an app, add the `FLIGHTDECK` service binding per stage, wrap the fetch handler with `withFlightdeck`, add `track()`/`identify()` in Workers and Durable Objects. Holds the shared event taxonomy and PII rules ([`references/events.md`](flightdeck-instrument-worker/references/events.md)) and a diff PII check ([`scripts/pii-check.sh`](flightdeck-instrument-worker/scripts/pii-check.sh)). |
| [`flightdeck-instrument-frontend`](flightdeck-instrument-frontend/SKILL.md) | Install `@flightdeckhq/browser`, init it in the client entry, route `/_fd/*` to the Worker, tag elements with `data-flightdeck`, and test the `/_fd/e` request. |
| [`flightdeck-fleet-rollout`](flightdeck-fleet-rollout/SKILL.md) | Inventory every Worker app, file per-repo issues, dispatch per-repo agents in waves, verify first events, and report a status table. |

## Install

Link each skill into your agent's skills directory. From a checkout of this repo at `<repo>`:

```bash
for s in <repo>/skills/flightdeck-*; do ln -s "$s" ~/.agents/skills/"$(basename "$s")"; done
```

On the maintainer's machine the checkout is the protected seed, so `wt seed sync` keeps the linked skills current:

```bash
ln -s /Volumes/dev/flightdeck/skills/<name> ~/.agents/skills/<name>
```

Claude Code reads `~/.claude/skills/<name>` (or a project's `.claude/skills/`); link there instead if that is where your agent looks.

## Keeping them accurate

Every snippet in these skills must match the current SDKs in `packages/worker` and `packages/browser`. When an SDK option or behaviour changes, update the skills in the same PR.

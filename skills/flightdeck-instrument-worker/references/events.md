# Flightdeck event taxonomy and PII rules

Shared by every app so parallel agents name things the same way. Read it before adding any `track()`, `identify()` or `data-flightdeck` attribute.

## Event kinds

| Kind | Who emits it | Name |
|---|---|---|
| `page` | browser SDK, automatically on load and SPA navigation | the path (Flightdeck normalizes it) |
| `click` | browser, `data-flightdeck="name"` on any non-form element | the attribute value |
| `submit` | browser, `data-flightdeck="name"` on a `<form>` | the attribute value |
| `view` | browser, element with `data-flightdeck="name"` and `data-flightdeck-view` | the attribute value |
| `track` | `track()` in the browser or `flightdeck(env).track()` on the server | you choose (rules below) |
| `identify` | `identify(userId)` | always `identify` |

## Naming rules

- `object.verb`, lowercase, words joined by `_` inside a segment: `issue.created`, `api_key.revoked`, `checkout.completed`.
- **Server events state facts in the past tense**: `issue.created`, `deployment.verified`, `invite.accepted`. Emit them after the write succeeded.
- **UI names describe the control, in the present tense**: `issue.create` (the button), `signup.form` (the form), `pricing.hero` (a viewed section), `nav.pricing` (a nav link). Prefix by area or page when the object alone is ambiguous: `settings.billing.upgrade`.
- One intent and its fact share the object so funnels line up: `issue.create` (click) -> `issue.created` (server).
- Names are constants in code. Never build a name from data (`"issue." + status` is fine only if `status` is a fixed enum).
- At most 256 characters, but aim for under 40.

## Shared vocabulary

Use these names where they apply, so cross-app dashboards work:

| Name | When |
|---|---|
| `user.signed_up` | an account was created |
| `user.signed_in` / `user.signed_out` | session started / ended (server) |
| `team.created`, `member.invited`, `invite.accepted` | collaboration |
| `subscription.started`, `subscription.changed`, `subscription.cancelled` | billing, props `{ plan }` |
| `checkout.started`, `checkout.completed` | payments, props `{ plan }` |
| `search.performed` | props `{ results }` count only, never the query |
| `export.downloaded`, `import.completed` | props `{ format, rows }` |
| `<object>.created` / `.updated` / `.deleted` | domain CRUD that matters to the product (issues, projects, deployments, games) |
| `onboarding.step_completed` | props `{ step }` (fixed step names) |
| `error.shown` | user-visible error state, props `{ code }` |

Domain events beyond this list are encouraged; keep them `object.verb`.

## Props

- Values: string, number, boolean or null. At most 32 keys; keys 1-64 chars; strings are cut at 512 chars; an event whose props serialize over 4 KiB is rejected.
- Keys in camelCase (`data-flightdeck-plan-tier` arrives as `planTier`).
- **Low cardinality**: enums (`plan`, `role`, `source`, `status`, `difficulty`), counts and durations (`rows`, `durationMs`). Never ids, never free text.

## PII rules (hard rules)

Never put any of these in event names, props, `data-flightdeck*` values, or custom paths:

- names, emails, phone numbers, addresses, birthdates, usernames/handles
- free text typed by users: search queries, messages, titles, comments, file names
- tokens, API keys, session ids, invite codes, URLs with query strings
- record ids that identify a person or their records: user ids in props, student ids, patient ids, order/customer ids, email-derived slugs

`userId` goes only in `identify()` (or the `userId` field of a server event), and it is your opaque internal id, never an email.

What Flightdeck already does:

- The browser SDK sends `location.pathname` only (no query string, no fragment) and the referrer's origin only.
- Ingest normalizes paths: segments that are numbers, UUIDs, ULIDs or 16+ hex chars become `:id`. **Slugs are not normalized**: `/students/jane-doe` is stored as is. Rewrite such paths with `beforeSend` (below).
- An Access-verified identity (the Cloudflare Access `sub`, an opaque id) replaces `userId` only for apps registered with an Access audience.

## Sensitive apps (school-os / educateos, anything with student, health or customer records)

Required configuration, in both SDKs. On the Worker it is only the body of the standard `fdOptions(env)` in the helper module (SKILL.md step 4); `withFlightdeck(handler, fdOptions)` and the `trackEvent`/`identifyUser` helpers stay exactly as for any other app, so existing `scheduled`/`queue` handlers and DO exports are untouched.

```ts
// Worker: the helper module (src/server/flightdeck.ts)
import { type ClientEventInput, type FlightdeckOptions, flightdeck } from "@flightdeckhq/worker";

const PERSON_PATH = /\/(students|guardians|staff)\/[^/]+/g;
const scrubPath = (path: string) => path.replace(PERSON_PATH, "/$1/:id");

export function fdOptions(env: Env): FlightdeckOptions {
  const salt = env.FLIGHTDECK_USER_SALT;
  // Guard: never send events from a sensitive app without its salt. The SDK contains the
  // throw: the app keeps serving, /_fd/e answers 500 and drops the batch, server calls are
  // logged and dropped, and the logs say why.
  if (typeof salt !== "string" || !salt) throw new Error("FLIGHTDECK_USER_SALT is not set");
  return {
    // userId -> SHA-256 hex of salt + userId, after beforeSend, before it leaves the Worker.
    hashUserId: { salt },
    beforeSend: (event: ClientEventInput) => ({
      ...event,
      path: event.path ? scrubPath(event.path) : event.path,
      name: event.kind === "page" ? scrubPath(event.name) : event.name,
    }),
  };
}

// trackEvent / identifyUser / send: unchanged from SKILL.md step 4.
```

```ts
// Browser: client entry
import { init } from "@flightdeckhq/browser";

const PERSON_PATH = /\/(students|guardians|staff)\/[^/]+/g;
const scrubPath = (path: string) => path.replace(PERSON_PATH, "/$1/:id");

init({
  redactProps: ["email", "name", "studentId", "query"], // applied before beforeSend
  beforeSend: (event) => ({
    ...event,
    path: event.path ? scrubPath(event.path) : event.path,
    name: event.kind === "page" ? scrubPath(event.name) : event.name,
  }),
});
```

- Adjust `PERSON_PATH` to the app's real routes: list every route with a person- or record-identifying segment that is not a numeric/UUID id.
- Store the salt as a Worker secret (`FLIGHTDECK_USER_SALT`, via `forge secret set` or `wrangler secret put`) in **every** stage, and declare it for `wrangler types` so `env.FLIGHTDECK_USER_SALT` typechecks. Before each deploy, confirm it exists: `wrangler secret list --env <env>` must list `FLIGHTDECK_USER_SALT`. Changing it changes every hashed id. Use the same salt across stages only if ids should match across them.
- Never use `hashUserId: true` (no salt) for a sensitive app. Unsalted SHA-256 of a guessable id (sequential numbers, emails, short codes) is reversed by hashing candidates. If `{ salt }` is missing or empty at runtime, the SDK drops `userId` (and warns once) rather than hash with a coerced salt.
- Hashing happens in the app Worker, so browser `identify()` and server events end up with the same hashed id.
- Do not `identify()` students or minors at all. Identify staff/teacher/admin accounts only, if needed.
- No `data-flightdeck-*` props on elements that render student data; tag the control, not the record.
- Prefer page and control events over domain events that describe a person (`grade.recorded` with props `{ scale }` is fine; anything about which student is not).
- Sensitive apps go last in a rollout wave, and their PR must list every event and prop for review.

## Self-check on your diff

Run the bundled check from the repo before opening the PR:

```bash
~/.agents/skills/flightdeck-instrument-worker/scripts/pii-check.sh               # since the merge base with origin/HEAD, incl. uncommitted and untracked files
~/.agents/skills/flightdeck-instrument-worker/scripts/pii-check.sh main...HEAD   # an explicit range
```

It scans every added line in files that import `@flightdeckhq/*`, contain `data-flightdeck`, or gain a `track`/`identify`/`trackEvent`/`identifyUser` call (so multi-line props objects are covered) for PII-like keys, free-text fields as props, dynamic event names, email-derived user ids and email literals. Exit 1 means hits: fix each one or explain it in the PR. Exit 2 means it could not find the default branch (`git remote set-head origin --auto`, or pass a range). It is a tripwire, not a proof: also read your own event list once against the rules above.

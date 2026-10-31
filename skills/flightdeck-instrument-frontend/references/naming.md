# data-flightdeck naming guide

Names follow the shared taxonomy in `flightdeck-instrument-worker/references/events.md`: `object.verb` or `area.element`, lowercase, `_` inside a segment, constant strings.

## What to tag (aim for 5-20 per app, not hundreds)

| Tag | Examples | Name pattern |
|---|---|---|
| Primary calls to action | sign up, start trial, create issue, new game, deploy | `<object>.<verb>`: `issue.create`, `game.start`, `trial.start` |
| Key forms | sign-up, sign-in, onboarding steps, checkout, invite, settings that matter | `<object>.form` or `<flow>.<step>`: `signup.form`, `onboarding.team_step` |
| Navigation that defines funnels | pricing link, docs link, upgrade banner | `nav.<target>`: `nav.pricing`, `banner.upgrade` |
| Important views | pricing plans, paywall, empty states, onboarding checklist, error states | `<page>.<section>` + `data-flightdeck-view`: `pricing.plans`, `issues.empty_state` |

## How UI names relate to backend events

- The control states the intent; the server states the fact. Same object, different tense:
  - button `issue.create` -> server `issue.created`
  - form `signup.form` -> server `user.signed_up`
  - button `checkout.start` -> server `checkout.completed`
- Agree on the object names with the backend agent (or the backend skill's event list) before tagging, so funnels join up.
- Do not duplicate a server fact with a client `track()`; the server event is authoritative.

## Props on elements

- Only fixed, low-cardinality values: `data-flightdeck-plan="pro"`, `data-flightdeck-placement="header"`, `data-flightdeck-variant="b"`.
- Bind them only to enums from code, never to user or record data:

```tsx
<button data-flightdeck="plan.select" data-flightdeck-plan={plan.tier}>Choose</button>   // tier is "free" | "pro"
```

## Never tag

- Elements whose name or props would need user data: list rows of people, records, messages, search result items. Tag the list container's controls instead (`roster.export`, not each student row).
- Inputs and text fields themselves (values are never captured, but tagging keystroke targets adds noise). Tag the form.
- Every link or button. Low-value clicks dilute the data and cost ingest.
- Password, payment, auth-token or admin-only destructive controls with props describing the target.
- Anything inside third-party iframes or widgets (not capturable anyway).

## Names to avoid

- Built from data: `` data-flightdeck={`project.${project.slug}`} ``. Put the variable in a fixed-enum prop, or drop it.
- Copy text: `"Get started now!"`. Copy changes; names must not.
- Generic: `button`, `click`, `submit`, `cta` without an area.

# 09 Metrics, scorecards and alerts

## 9.1 Metric catalog

Every metric has a stable id, a precise definition built on 04, a population, a censoring rule and
a direction. The API, scorecards, alerts and MCP all refer to metrics by id; nothing computes its own
variant.

| Id | Definition | Population | Censoring | Better |
|---|---|---|---|---|
| `li.lead_time` | `closedAt − createdAt` (final close) | Cases closed in window (closed cohort) | KM median also reported with open cases censored at `asOf` | lower |
| `li.lead_time_first_close` | `firstClosedAt − createdAt` | same | same | lower |
| `li.queue_time` | `startedAt − createdAt` | Cases with `case.started` | open cases without start censored | lower |
| `li.active_time` | lead time − paused − closed gap | Closed cases | KM as above | lower |
| `li.stage_dwell` | Wall dwell per stage instance (04 §4.6) | Instances exited in window | KM with open instances | lower |
| `li.stage_active_dwell` | Wall dwell − paused | same | same | lower |
| `li.blocked_share` | Σ blocked / Σ active time | Instances or cases in window (`time_share`) | includes open time up to `asOf`, flagged | lower |
| `li.pause_share` | Σ paused / Σ elapsed | same | same | context |
| `li.flow_efficiency` | Σ working / Σ active time | Closed cases | closed only | higher |
| `li.wip` | Open cases at `asOf` (or at each bucket end) | Open cases | n/a | context |
| `li.wip_age` | p50/p90 of `asOf − currentStageEnteredAt`, and of `asOf − createdAt` | Open cases | n/a (age, not duration) | lower |
| `li.age_limit_breaches` | Open instances with age > `ageLimitMs` | Open instances | n/a | lower |
| `li.throughput` | Cases closed per bucket, by outcome | Closed cohort | n/a | context |
| `li.arrivals` | Cases created per bucket | Opened cohort | n/a | context |
| `li.conversion` | Share of cases reaching canonical stage B among those reaching A | Opened cohort | maturity rule (04 §4.8) | higher |
| `li.yield` | success closes / all closes | Closed cohort | n/a | higher |
| `li.first_pass_yield` | Cases whose first instance of a stage didn't exit with a failure reason | Instances of that stage | n/a | higher |
| `li.rework_rate` | Cases with > 1 visit to any non-terminal stage / cases | Closed cohort | n/a | lower |
| `li.reopen_rate` | Cases with `reopen_count > 0` / cases closed at least once | Closed cohort | n/a | lower |
| `li.attempts_per_success` | Σ instances of a stage / cases that passed it | Instances of the stage | n/a | lower |
| `li.related_rate` | Cases with ≥ 1 incoming relation of type T / cases | Closed cohort | n/a | context |

Rates come with a Wilson 95% interval. Durations come with `p50`, `p90`, `km_median` and `n`. Every
value obeys the suppression rules (06 §6.4).

### Domain presets (named views over the catalog, not new math)

| Domain | Preset | Catalog expression |
|---|---|---|
| Hiring | Time to offer | `li.lead_time` variant: `createdAt` → first entry to canonical `offer` (a "time to stage" form of `li.conversion` timing) |
| Hiring | Interview loop dwell | `li.stage_dwell` on canonical `interview` (merged across v1/v2) |
| Hiring | Scheduling drag | `li.blocked_share` filtered to reason `interviewer_availability` |
| Hiring | Offer acceptance | `li.conversion` from `offer` to the `hired` terminal |
| Deployment | Lead time for changes | `li.lead_time` on `delivery.deploy` (`createdAt` = change merged) |
| Deployment | Deployment frequency | `li.throughput` with outcome `success`, per day |
| Deployment | Change failure rate | `1 − li.yield`, or `li.related_rate` with incoming `caused_by` from `incident.response` |
| Deployment | Approval wait | `li.stage_dwell` on `approval` |
| Incident | Time to mitigate | `createdAt` → first entry to canonical `monitoring` |
| Incident | Time to resolve (first) | `li.lead_time_first_close` |
| Incident | Reopen rate | `li.reopen_rate` |
| Incident | Vendor drag | `li.blocked_share` on reason `vendor_response` |

"Time to stage X" is the one derived form presets add: `min(enteredAt of canonical X) − createdAt`,
censored at `asOf` for open cases that haven't reached X, and excluded (counted in `n_excluded`
as `closed_without_stage`) for closed cases that never reached it.

## 9.2 Scorecards

A scorecard is a saved, versioned set of metric targets for one process, evaluated weekly and on
demand.

```json
{
  "scorecardId": "deploy-health",
  "processId": "delivery.deploy",
  "version": 1,
  "window": { "length": "28d", "compareTo": "previous" },
  "filters": { "env": "production" },
  "items": [
    { "metric": "li.lead_time", "stat": "km_median", "target": { "lte": "PT4H" }, "warn": { "lte": "PT8H" }, "minN": 20 },
    { "metric": "li.yield", "target": { "gte": 0.95 }, "warn": { "gte": 0.9 }, "minN": 20 },
    { "metric": "li.stage_dwell", "stage": "approval", "stat": "p90", "target": { "lte": "PT2H" }, "minN": 20 },
    { "metric": "li.blocked_share", "target": { "lte": 0.15 }, "minN": 20 }
  ]
}
```

Evaluation rules:

- Each item's status is `met`, `warn`, `missed`, or `insufficient_data` (when `n < minN` or the
  value is suppressed). **`insufficient_data` is never shown as met.**
- `compareTo: "previous"` shows the prior window's value and its interval. The delta is labelled
  "changed" only when the two Wilson intervals (rates) don't overlap, or when both windows have
  n ≥ 30 and the medians differ by more than 10%. Otherwise it is "no clear change".
- Comparisons across definition versions follow comparability (05 §5.3). A `not_comparable` item
  shows the current window only.

Storage:

```sql
CREATE TABLE li_scorecards (
  app_id TEXT NOT NULL, scorecard_id TEXT NOT NULL, version INTEGER NOT NULL,
  process_id TEXT NOT NULL, body TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, scorecard_id, version)
) WITHOUT ROWID;
CREATE TABLE li_scorecard_snapshots (
  app_id TEXT NOT NULL, scorecard_id TEXT NOT NULL, version INTEGER NOT NULL, window_end TEXT NOT NULL,
  result TEXT NOT NULL,   -- items with value, n, interval, status; already suppressed
  PRIMARY KEY (app_id, scorecard_id, version, window_end)
) WITHOUT ROWID;
```

API: `GET /scorecards`, `GET /scorecards/:id` (latest snapshot plus a live evaluation),
`POST /scorecards` (`owner`), `GET /scorecards/:id/history`.

## 9.3 Alerts

### Rule types

| Type | Fires when | Example |
|---|---|---|
| `stage_age` | Any open instance of stage S exceeds `ageLimitMs` (the rule's value or the definition default) | Deploy stuck in `verify_production` > 30 min |
| `stalled` | An open case has had no effective event for D | Incident with no event for 4 h |
| `metric_threshold` | A catalog metric over a sliding window crosses a threshold, with `minN` | `li.yield` over 24 h < 0.9 with n ≥ 10 |
| `wip_limit` | WIP in stage S > L | More than 15 applications in `screen` |
| `freshness` | `projected_through` older than T, or a reconcile `mismatch` | Operator alert |

Count-based rules on restricted processes fire on aggregate breaches only, and their notifications
name no case ids.

### Evaluation

- Runs in the `*/5` cron (07 §7.3) after the aggregation step.
- **State machine per rule and subject** (subject = a case for `stage_age`/`stalled`, the process
  otherwise): `ok → pending → firing → resolved`. `pending → firing` needs the condition to hold for
  `for` (default 10 min, i.e. two consecutive evaluations). `firing → resolved` needs it to stay
  false for `for` too: hysteresis, so a value hovering at the threshold doesn't flap.
- **Dedup key**: `(rule_id, subject)`. One notification on firing, one on resolve, and a reminder
  every `repeat` (default 24 h) while firing.
- **Muting**: `mutedUntil` per rule; scheduled change freezes can mute deploy rules.

```json
{
  "ruleId": "deploy-verify-stuck",
  "processId": "delivery.deploy",
  "type": "stage_age",
  "stage": "verify_production",
  "ageLimit": "PT30M",
  "for": "PT10M",
  "repeat": "PT6H",
  "channels": ["ops-webhook"],
  "severity": "page"
}
```

```sql
CREATE TABLE li_alert_rules (
  app_id TEXT NOT NULL, rule_id TEXT NOT NULL, process_id TEXT NOT NULL, body TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1, muted_until INTEGER,
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, rule_id)
) WITHOUT ROWID;
CREATE TABLE li_alert_state (
  app_id TEXT NOT NULL, rule_id TEXT NOT NULL, subject TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'firing', 'resolved')),
  since INTEGER NOT NULL, last_notified_at INTEGER, last_value REAL,
  PRIMARY KEY (app_id, rule_id, subject)
) WITHOUT ROWID;
CREATE TABLE li_alert_channels (
  app_id TEXT NOT NULL, channel_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('webhook')),
  url TEXT NOT NULL, secret_name TEXT NOT NULL,   -- Worker secret binding name, never the secret
  PRIMARY KEY (app_id, channel_id)
) WITHOUT ROWID;
```

### Notification payload

A signed webhook (`X-Flightdeck-Signature: t=<ts>,v1=<hex HMAC-SHA256(secret, t + "." + body)>`).
It contains codes and links only:

```json
{
  "type": "li.alert.firing",
  "app_id": "app_delivery",
  "rule_id": "deploy-verify-stuck",
  "process_id": "delivery.deploy",
  "severity": "page",
  "subject": { "kind": "case", "case_id": "dpl_9a40d2" },
  "value": { "age_ms": 2460000, "limit_ms": 1800000 },
  "since": 1791546000000,
  "link": "https://flightdeck.example.com/processes/delivery.deploy/cases/dpl_9a40d2?app=app_delivery"
}
```

For restricted processes `subject` is `{ "kind": "process" }` and `link` points at the aggregate view.

Delivery retries 3 times with backoff (1 s, 10 s, 60 s), then records `last_error` and shows the
channel as degraded in `/li/health`. Alerts are at-least-once; receivers dedupe on
`(rule_id, subject.case_id or "process", since)`.

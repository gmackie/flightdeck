# 04 Time semantics

These rules are normative. Workstream B's fold must implement them, D1 aggregates must preserve
them, and every API and UI label must use these words with these meanings. Each rule has a
test-vector ID (`T-…`) that the contract suite (Gate G2) must cover.

## 4.1 Clocks

| Clock | Field | Set by | Used for |
|---|---|---|---|
| Occurrence time | `occurredAt` | Producer | **All durations and ordering.** Never clamped (D3). |
| Producer order | `sourceSequence` | Producer | Tie-break when `occurredAt` is equal. |
| Receipt time | `received_at` | Flightdeck ingest | Freshness, reconciliation hours, lateness diagnostics, retention clocks. Never used for durations. |
| Evaluation time | `asOf` | Query or projection | "Now" for open cases. Every response states it. |

All times are UTC epoch milliseconds. Days and weeks are UTC: days start at 00:00Z and weeks on
Monday 00:00Z. The UI may label a display time zone, but buckets don't move with it in v1.

**Ordering** within a case is `(occurredAt, sourceSequence, eventId)`, ascending. `eventId` breaks
ties only as a last resort, to keep the fold deterministic; producers should make it unnecessary
(T-ORD-1).

## 4.2 Stage instances are half-open intervals

A stage instance occupies `[enteredAt, exitedAt)`. While open, its interval is `[enteredAt, asOf)`
and it is **censored**.

- **Exclusive track.** A case has at most one open non-terminal stage instance. A
  `stage.entered` while another is open closes the open one at the new `enteredAt` and raises the
  diagnostic `implicit_exit` (T-STG-1). Parallel work is modelled as child cases (05 §5.6), not as
  overlapping stages.
- **Re-entry is a new instance.** Entering stage `screen` a second time with a new
  `stageInstanceId` gives `visit = 2`. That is how rework and retries are counted (T-STG-2).
- **Skipped** (`stage.skipped`) is a zero-length instance with `skipped = 1`. It is excluded from
  dwell and counted separately in funnels (T-STG-3).
- **Terminal stages** (`kind: "terminal"` in the definition, 05) close the case's active time.
  Entering one sets the case's `closedAt` (if no `case.completed`/`case.terminated` came earlier)
  and its outcome. Terminal instances have no dwell (T-STG-4).
- **Exit without entry**: the event is kept in the log and ignored by the fold; raises
  `exit_without_entry` (T-STG-5).

## 4.3 Pauses and blocks

| | Pause | Block |
|---|---|---|
| Meaning | Intentional clock stop: the case is not supposed to progress | Impediment: the case should progress but can't |
| Examples | Applicant asked to delay; change freeze; incident in "waiting for customer" by policy | Awaiting approver; interviewer availability; vendor response; canary hold |
| Scope | `case.paused` (whole case) or `stage.paused` (one instance) | `stage.blocked` (one instance) |
| Identity | One open pause per scope; a second `paused` while paused is a no-op plus diagnostic `duplicate_pause` | `(stageInstanceId, reason)`; a second identical `stage.blocked` while open is a no-op plus `duplicate_block` |
| Overlap | Case and stage pauses are unioned | Different reasons may overlap; overlap counts once (§4.5) |
| Closed by exit | An open stage pause ends at the instance exit; a case pause carries on into the next stage | An open block ends at instance exit; raises `block_closed_by_exit` |

## 4.4 Decomposition of elapsed time (D6)

Every instant between `createdAt` and `closedAt` (or `asOf` while open) is assigned to exactly one
category, in this precedence:

1. **paused**: a case pause is open, or a stage pause is open on the open instance;
2. **blocked**: otherwise, at least one block is open on the open instance;
3. **working**: otherwise, a non-terminal stage instance is open;
4. **between stages**: no stage instance is open and the case is open;
5. **closed gap**: the case was closed and later reopened (§4.10).

So `working + blocked + paused + between + closedGap = elapsed` always holds, for a case and,
without the last two terms, for a stage instance (T-DEC-1). "Working" means "open and not paused
or blocked". It does not claim anyone was busy.

Derived ratios:

- **Active time** = elapsed − paused − closed gap.
- **Flow efficiency** = working / active time.
- **Blocked share** = blocked / active time.

### Worked example (T-DEC-2)

A stage instance `onsite`, entered 2026-09-15 00:00Z and exited 2026-09-22 00:00Z (168 h), with:

- block `interviewer_availability`, 09-15 00:00 → 09-18 00:00 (72 h)
- block `awaiting_feedback`, 09-17 00:00 → 09-19 00:00 (48 h)
- case pause `requested_delay`, 09-18 12:00 → 09-19 12:00 (24 h)

```
time (Sep, 00:00Z)   15        16        17        18        19        20 ... 22
interviewer_avail.   ██████████████████████████████
awaiting_feedback                        ████████████████████
case pause                                              ██████████
category             BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBPPPPPPPPPPWWWWWWWWWWWWWWWWWWWWWWWWW...W
                     B = blocked, P = paused, W = working (one character = 2.4 h)
```

| Category | Computation | Hours |
|---|---|---|
| paused | pause lies inside the instance | 24 |
| blocked | union of blocks `[15 00:00, 19 00:00)` minus pause `[18 12:00, 19 12:00)` = `[15 00:00, 18 12:00)` | 84 |
| working | 168 − 24 − 84 | 60 |

A naive sum of the blocks (72 + 48 = 120 h) would claim more blocked time than the instance had
unpaused time in that window. The union rule prevents it.

## 4.5 Overlapping blockers: attribution by reason (D7)

Blocked time is reported once (the union), but people also ask "how much was each reason
responsible for?". Over the blocked, unpaused time, each instant is split equally among the reasons
open at that instant. Reason totals then add up exactly to the blocked total (T-BLK-1).

For the example above:

| Window | Open reasons | `interviewer_availability` | `awaiting_feedback` |
|---|---|---|---|
| 15 00:00 → 17 00:00 | one | 48 h | 0 |
| 17 00:00 → 18 00:00 | both | 12 h | 12 h |
| 18 00:00 → 18 12:00 | `awaiting_feedback` only | 0 | 12 h |
| 18 12:00 → 19 00:00 | both, but paused | 0 | 0 |
| **Total** | | **60 h** | **24 h** (sum 84 h = blocked) |

The UI may also show each reason's **raw** open duration (72 h and 48 h here), labelled "open
duration, overlaps counted in each". Never present raw durations as shares.

## 4.6 Dwell

| Measure | Definition |
|---|---|
| Wall dwell | `exitedAt − enteredAt` for a closed instance |
| Active dwell | wall dwell − paused |
| First-visit dwell | wall dwell of `visit = 1` instances only |
| Total stage time per case | sum of wall dwell over all visits of a stage in a case |
| Current age | `asOf − enteredAt` for an open instance; **reported as age, never as dwell** |

Stage dwell statistics are always reported by stage **visit population** (all visits, or first
visits) and say which one. Default: all visits.

## 4.7 Censoring (D8)

An open case or instance has an unknown final duration that is at least its current age. Ignoring
open cases biases durations low, because long cases are the ones still open. Counting their current
age as if they had closed also biases low. So every duration answer carries:

- **Closed-only percentiles** (p50, p90) over closed items, labelled as such;
- **Kaplan–Meier median** over closed items (events) and open items (censored at their age), or
  `null` with `km_median_reached: false` when the survival curve hasn't fallen to 0.5;
- `n` (all items), `n_closed`, `n_censored`, `n_excluded` (with reasons, such as `invalid_time` or
  `erased`).

### Worked example (T-CEN-1)

Five cases: closed after 2, 4 and 9 days; open at ages 5 and 12 days.

| t (days) | at risk | events | S(t) |
|---|---|---|---|
| 2 | 5 | 1 | 0.800 |
| 4 | 4 | 1 | 0.600 |
| 5 (censored) | 3 | 0 | 0.600 |
| 9 | 2 | 1 | 0.300 |
| 12 (censored) | 1 | 0 | 0.300 |

Closed-only median = **4 days**. Kaplan–Meier median = **9 days** (first t with S(t) ≤ 0.5). The
API returns both; the UI leads with the Kaplan–Meier median when `n_censored / n ≥ 0.2` and shows
the closed-only value as secondary.

Percentiles use the **nearest-rank** method on exact values (`p`-th = value at rank
`ceil(p × n)`) when computed from rows, and log-bucket histograms (≤ 4% relative error) when
computed from daily aggregates; the response says which (`method: "exact" | "histogram"`).

## 4.8 Cohorts and maturity

- **Opened cohorts** group cases by the UTC week (or day or month) of `createdAt`. **Closed
  cohorts** group by `closedAt`. Each answer says which. Throughput uses closed cohorts; conversion
  and time-to-X use opened cohorts.
- **Maturity.** "Converted within N days" for an opened cohort only counts cases with at least N
  days of exposure (`asOf − createdAt ≥ N days`). A cohort where not every case is mature returns
  `mature: false` and `n_mature` (T-COH-1). The UI greys immature cells instead of showing a falsely
  low rate.
- **Open-cohort snapshots**: WIP and WIP age are point-in-time at `asOf`. "WIP on day D" uses cases
  with `createdAt < D_end` and (`closedAt` null or `closedAt ≥ D_end`).

## 4.9 Out-of-order arrival, duplicates and corrections

- **Out of order.** The CaseDO keeps the whole log and re-folds on every change, so the projection
  depends only on the set of effective events, not their arrival order (T-OOO-1, a
  permutation-invariance property test).
- **Duplicates.** The same `eventId` with the same payload is a no-op (T-DUP-1). With a different
  payload, the first received wins and `conflicting_duplicate` is raised (T-DUP-2). To change an
  event, send a correction.
- **Corrections** (`event.corrected`):
  - `retract`: the target is treated as never having happened (T-COR-1).
  - `amend`: replaces the target's `occurredAt` and/or `dimensions` (T-COR-2).
  - A correction that arrives **before** its target waits in the log and applies when the target
    arrives (T-COR-3). If the target never arrives, `orphan_correction` is raised at projection
    time while the case is open, and at close.
  - Several corrections to one target apply in `(occurredAt, sourceSequence, eventId)` order of
    the corrections; the last amend wins, and any retract wins over amends (T-COR-4).
  - Correcting a correction is rejected at ingest (permanent 400) to keep the semantics flat.
- **Events after close.** Stage events after `closedAt` and before any `case.reopened` are kept and
  ignored by the fold; raises `event_after_close` (T-CLS-1).

## 4.10 Reopen

`case.reopened` at time R on a case closed at C:

- `first_closed_at` keeps the first C; `closed_at` is cleared until the next close;
  `reopen_count` increments.
- `[C, R)` is **closed gap** time. It is part of elapsed lead time to the final close, and is
  excluded from active time and flow efficiency (T-RO-1).
- Metrics offer both **time to first close** and **time to final close**. Incident MTTR
  conventionally uses first resolution; the metric catalog (09) names which one each metric uses.

## 4.11 Retries and attempts

A retry is a new instance of the same stage, usually after `stage.exited` with `reason: "failed"`.
Reported measures (T-RTY-1):

- `attempts` per case and stage = number of non-skipped instances;
- **first-pass yield** = share of cases whose first instance of a stage exited without
  `reason ∈ definition.failureReasons` (05);
- **retry time** = wall dwell of all instances after the first.

## 4.12 Missing and invalid time

| Situation | Handling | Diagnostic |
|---|---|---|
| No `case.created` | Use the earliest effective event's `occurredAt` | `missing_case_created` |
| `occurredAt` more than 5 min after `received_at` | Batch rejected at ingest | none (never stored) |
| An interval with end < start after corrections | Instance excluded from dwell, counted in `n_excluded` | `invalid_interval` |
| Unpaired `stage.unblocked` / `resumed` | Ignored | `unblock_without_block` / `resume_without_pause` |
| Open block or pause on a closed case | Closed at `closedAt` | `block_closed_by_exit` / `pause_closed_by_close` |

## 4.13 Not in v1

- **Business calendars** (working hours, holidays). v1 is wall-clock only. The definition reserves
  a `calendar` field (05) so a later version can add `business_ms` columns next to the wall-clock
  ones without changing the meaning of existing columns.
- **Fractional or partial stage membership.** A case is in one exclusive stage at a time.

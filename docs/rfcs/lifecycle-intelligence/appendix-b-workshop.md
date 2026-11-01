# Appendix B: Workshop guide

A 2½-hour working session for workstream owners (A, B, C, E, F) and the repository owner. Output:
statuses for D1–D16 and OQ-1–OQ-8 in [13](13-decision-records.md), owners and dates for gates G1–G8,
and the PR plan confirmed or amended.

## Pre-reads (30 minutes)

README, 02, 04, Appendix A. Skim the rest.

## Agenda

| Time | Session | Output |
|---|---|---|
| 0:00–0:15 | Boundary check: walk through 02 §2.1. Does anyone's workstream make Flightdeck a system of record? | D1 confirmed |
| 0:15–0:45 | **Vocabulary (G1).** Go through the G1 table line by line; decide each normalized name and field; decide the three sub-decisions in D2 | D2 accepted; G1 owner and date |
| 0:45–1:15 | **Semantics drill.** Each participant computes the `onsite.1` decomposition (04 §4.4) and the incident attribution (examples) on paper, then compares with B's engine output | Agreement, or 04 amended |
| 1:15–1:25 | Break | |
| 1:25–1:50 | **Definitions (G5).** Which 05 §5.1 additions go into A's v1 schema and which are deferred to v2 | G5 decision |
| 1:50–2:10 | **Privacy (G7).** Walk the threat model (06 §6.1). Decide OQ-3 and OQ-4. Confirm the hiring fixture contains nothing personal | G7 checklist owner |
| 2:10–2:30 | **Plan.** Walk the 12 PRs and their prerequisites; map them to workstreams; agree on the integration branch for G2 | Owners and order |

## Exercises

1. **Overlap.** Using `examples/hiring/events.ndjson`, delete the `case.paused`/`case.resumed`
   lines. What are `onsite.1`'s working, blocked and paused times, and the attribution? (Answer:
   wall 168 h; blocked = union 96 h, attributed 60 h interviewer (48 + 12) and 36 h feedback
   (12 + 24); working 72 h; paused 0.)
2. **Censoring.** Take T-CEN-1 (04 §4.7). Add a sixth case still open at 1 day. What happens to the
   KM median? (Answer: at risk becomes 6 at t = 1 (censored), then 5 at t = 2; S(2) = 0.8,
   S(4) = 0.6, S(9) = 0.3; median still 9. Early censoring removes a case from the risk set without
   pulling S(t) down.)
3. **Comparability.** A v3 of hiring merges `applied` and `screen` into one stage `intake` with
   `canonicalStageId: "intake"`, while v1 and v2 use the canonical ids `applied` and `screen`. Can
   v3's intake dwell be compared with v1 and v2? (Answer: no. `intake` has no counterpart, so it is
   `not_comparable`, and published definitions can't be re-mapped afterwards. Had v1 given both
   `applied` and `screen` the canonical id `intake` from the start, v1's consecutive applied and
   screen instances would form one canonical `intake` visit (05 §5.3.1), and v3 would compare with v1 at the canonical level.
   Lesson: choose canonical ids for the coarsest comparison you'll ever want.)
4. **Correction race.** The retraction `hire-0019` arrives before its target `hire-0013`. What does
   the CaseDO do? (Answer: logs it, waits; when `hire-0013` arrives it is ignored by the fold. Same
   projection; no diagnostic unless the target never arrives (`orphan_correction`).)
5. **Suppression.** A reader asks for hiring flow broken down by `level` over 14 days. What happens?
   (Answer: 422, because restricted processes need a window of at least 28 days. With 28 days, a
   level with fewer than 10 cases is suppressed, plus complementary suppression of the next-smallest
   level if only one cell is suppressed.)

## Decision log template

```
Decision: D2 sub-decision "reason required on blocks"
Status: Accepted | Rejected | Deferred
Date: 2026-11-__
Who: <workstream owners present>
Notes:
Follow-up issue:
```

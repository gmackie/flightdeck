# 11 UI: nested segmented bars

Workstream C (FLIG-15) is building `LifecycleBar` and `LifecycleRow` on local fixtures. This
section is the contract those components must meet when they switch to the real API (PR-11 in the
plan).

## 11.1 Anatomy

```
Interview loop ───────────────────────────┐   Offer ───┐
┌─────────┬───────────────────┬────────────┬──────────┬─────┐
│ Screen  │ Technical         │ Team       │ Offer    │ ··· │   ← level 1: stages, grouped (outer ticks)
│▓▓▓▓░░░··│▓▓▓▓▓▓▓▓////////:::│▓▓▓▓▓▓///░░░│▓▓▓▓::::::│     │   ← level 2: working ▓ blocked / paused : open ░
└─────────┴───────────────────┴────────────┴──────────┴─────┘
 0                                                     100% of case time
```

| Level | Encodes | Source field (08 `/flow`) |
|---|---|---|
| Outer group | `stages[].group` span, a labelled bracket above the bar | `groups[].group` |
| Stage segment | Share of total time spent in the stage | `working_ms + blocked_ms + paused_ms` of the stage / `total_ms` |
| Inner fill | Working, blocked, paused within the stage, in that fixed order | `working_ms`, `blocked_ms`, `paused_ms` |
| Overlay | Part contributed by still-open instances, hatched | `open_ms` |
| Tail segment | Between stages (neutral, outlined) | `between_ms` |

## 11.2 What a bar may encode (D15)

Stacking only works for quantities that add up. Allowed bar modes:

| Mode | Segment length | Reads as | Default for |
|---|---|---|---|
| `time_share` | Σ time in stage across cases / Σ total time | "Where did the time go?" | Process overview |
| `mean_per_case` | Σ time in stage / number of cases in the population | "A case spends on average X d in screen" | Portfolio rows |
| `case` | This case's actual intervals on a time axis | "What happened to this case?" | Case detail |

**Never stack medians or percentiles**: the p50 of a sum isn't the sum of the p50s, and a bar of
stacked medians implies a typical case nobody had. Percentiles go in a separate **dot strip** under
the bar (p50 dot, p90 tick, Kaplan–Meier median ring when censoring is ≥ 20%), aligned per stage,
and in the table.

Further rules:

- The axis is labelled with the mode ("Share of case time", "Mean days per case").
- The inner order is fixed (working, blocked, paused, left to right) so eyes can compare across
  rows.
- Rows that pool versions show a `merged` badge; `not_comparable` populations are never drawn in one
  bar (05 §5.3).
- Suppressed stages draw as a neutral striped segment labelled "fewer than k cases", with their
  share folded into "Other", so the remaining shares don't leak the suppressed value by subtraction.
- Segments narrower than 2% of the bar merge into an "Other" segment in the bar; the table and
  tooltip still list them individually.
- Each `LifecycleRow` with children has a disclosure that expands child processes underneath (the
  tree from 05 §5.5). Children's bars use their own scale, labelled as such.

## 11.3 Color and pattern

Use Kumo theme tokens, and follow the dashboard's light and dark switch (Kumo's `data-mode`,
kept in step with the system setting by `apps/dashboard/src/theme.ts`).

| State | Fill | Pattern | Why |
|---|---|---|---|
| Working | stage color, full strength | solid | |
| Blocked | stage color, 70% | 45° diagonal hatch | Not distinguished by color alone |
| Paused | neutral (`--muted`) | dots | Clock stopped; deliberately not the stage color |
| Open (censored) | overlay | cross-hatch at 30% opacity | "Still accumulating" |
| Between stages | transparent | 1 px dashed outline | Time outside any stage |
| Suppressed | neutral | wide stripes | Clearly "no data shown" |

- Adjacent segments are separated by a 1 px gap in the background color, so neighbors of similar
  color stay distinct.
- Every state pattern must reach 3:1 contrast against its neighbors and the background (WCAG 2.2
  1.4.11, non-text contrast), checked in light and dark themes. Text labels must reach 4.5:1.
- Stage colors come from a categorical palette of at most 8 colors, assigned by canonical stage
  order. Groups beyond 8 colors reuse hues with group brackets for distinction.

## 11.4 Interaction

- **Hover and focus show the same tooltip**: never hover-only.
- **Keyboard**: the bar is one tab stop (`role="group"`, `aria-roledescription="segmented bar"`).
  Within it, Left and Right move between stage segments, Up and Down move between the inner states
  of the focused stage, Home and End jump to the ends, Enter drills into the stage (filtered case
  list or stage view), and Escape returns focus to the bar. This uses a roving `tabindex`.
- **Pointer targets** are at least 24 × 24 CSS px (WCAG 2.2 2.5.8). Thin segments are reachable by
  keyboard, and through the "Other" expansion in the table.
- **Drill-down** preserves the query (`from`, `to`, `versions`, filters) in the URL, like the
  existing `?app=` handling in `apps/dashboard/src/router.ts`.

## 11.5 Screen readers and text equivalents

- Each bar has an accessible name and a summary: `aria-label="Hiring application, time share,
  91 days to Oct 5: 7 stages"`, and `aria-describedby` pointing at a visually hidden summary
  listing the top three stages by share.
- Each stage segment is announced as: "Technical interview, 31 percent of case time, mean 4.2 days
  per case, of which blocked 0.8 days and paused 0.3 days, 62 cases, 5 still open." Numbers are
  rounded the same way as the visible table.
- A **"Show as table" toggle** sits next to every bar chart and renders the same data as a real
  `<table>` with `<caption>`, `scope`d headers, and the `meta` footer (n, censored, as of,
  comparability). It is the canonical accessible form; the bar is the visual summary.
- Suppression is announced in words ("fewer than 10 cases, not shown").

## 11.6 Motion

- Segments may grow from 0 to their width over 200 ms on first render, to show composition. No
  animation on data refresh beyond a 120 ms width transition.
- With `prefers-reduced-motion: reduce`: no growth, no transitions.
- No animation conveys information that isn't also static.

## 11.7 Freshness and sample in the UI

Every chart card shows a footer: "n = 214 cases (46 open) · as of 10:41 UTC · data through 10:40 ·
verified through 21:00 yesterday". When `pending_cases > 0` or `lag_p95_ms > 60 s`, a warning chip
says "Updating" with the lag. When `verified_through` is more than 6 hours old, it says
"Unverified recent data".

## 11.8 Implementation notes

- Build the bar as HTML/CSS (flex segments with CSS background patterns) or inline SVG in React,
  not ECharts. ECharts renders well, but per-segment keyboard focus and roving tabindex are much
  easier with DOM elements. ECharts stays for time series (throughput, cohorts), as on the Trends
  page.
- Component tests (C's suite plus PR-11): axe-core checks in light and dark, keyboard path tests,
  "never stacks percentiles" (the component accepts only additive fields), and snapshots of the
  table equivalent.

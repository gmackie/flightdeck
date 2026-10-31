# Workflows UI demo (WORKSTREAM C / FLIG-15)

Open `/workflows` in the dashboard (`pnpm --filter @flightdeckhq/dashboard dev`).
This route renders local, invented fixtures without requesting `/api/apps`, fetching workflow data, or opening a live socket. The sidebar, header, notice, and source label identify it as a synthetic demo. Examples do not represent actual Cloudflare resources, employees, candidates, deployments, or incidents.

The hierarchy starts with headcount demand, requisition, application, interview loop, and parallel assessments. **Interview loops** have Defined → Interviewers assigned → Scheduled → Conducted → Feedback → Debrief → Decision. **Assessments** have Assigned → Scheduled → Conducted → Scorecard → Finalized. An application's interview stage is a separate lifecycle. The three assessments deliberately show different concurrent progress. Pending, deferred, and rejected headcount demand remain visible at the top level. The **Many jobs** layout shows twelve requisitions; two other domains show invented service deploys and incidents.

`LifecycleBar`, `LifecycleRow`, `LifecycleTree`, `LifecyclePortfolio`, and `PortfolioSummary` take domain-neutral dashboard read models. A parent's stages and state are supplied explicitly; rejected/withdrawn children never rewrite them. Domain selection and the requisition-only view belong to the demo page. Shared schema, process engine, ingest, and production data are outside this PR.

`src/workflows/adapter.ts` defines the data boundary. Replace the fixture adapter with an API-to-dashboard mapper when the other workstreams provide their API. Components do not import shared lifecycle schemas or depend on an endpoint shape. The current adapter reads a synchronous snapshot; a future data hook can load that snapshot before rendering.

Metrics use the frozen fixture time (2026-10-31 12:00 UTC). Stage dwell is exit minus entry, or snapshot minus entry for an open stage. Future stages have no dwell. p50/p90 use nearest rank across all entered stages in the displayed portfolio, including nested children and ongoing dwell. These are descriptive stage-duration percentiles, not completed-only cohort latency or SLAs. State/outcome counts count each workflow's own state, including parents. Each job's metrics include its own lifecycle and descendants. Row age freezes at the end of terminal workflows; tooltip age is time since stage entry. Equal-width segments show sequence, not relative duration.

Keyboard behavior:

- Tree: Up/Down traverse visible rows, Right expands or enters a child, Left collapses or returns to the parent, Home/End move to the first/last visible row, Enter/Space toggle. Disclosure buttons also support native keyboard activation.
- Stage toolbar: one tab stop per bar; Left/Right move between stages and wrap, Home/End move to its boundaries. Focus or hover opens stage details. Click/tap opens them too; Escape dismisses without moving focus.
- Scroll regions are focusable for keyboard horizontal scrolling at narrow viewport widths. Controls have visible focus outlines and named ARIA groups, trees, toolbars, and tooltips.
- State labels and symbols supplement color. Text/fill pairs meet WCAG AA (4.5:1), including dark future stages; withdrawn is neutral/dashed, future muted/dotted. Reduced-motion preferences disable demo/tooltip animation; forced colors retain borders and focus indicators.

Validation commands and evidence are recorded in the draft PR. Automated coverage includes hierarchy navigation, tooltip accessibility/content, independent parent state, separate loop/assessment stages, all three demo domains, twelve-job layout, search/empty states, adapter injection, no API/sockets on the demo route, percentiles/dwell, and actual CSS color-pair contrast. Browser layout and screen-reader acceptance remain manual review items; DOM tests do not establish those results.

Delivery target: non-deploying. Draft PR only; no merge or deployment.

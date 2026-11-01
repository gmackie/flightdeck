# Lifecycle MCP acceptance (synthetic, two domains)

End-to-end acceptance for the read-only lifecycle MCP server (`apps/lifecycle-mcp`, FLIG-31).
The tests use the official `@modelcontextprotocol/client` 2.4.0, pinned to protocol `2026-07-28`.
They talk to the real Worker handler (`handleRequest`) with a locally signed Cloudflare Access
JWT and the injected synthetic source. Nothing is mocked between the client and the source, and
no LLM runs anywhere: the test plays the analyst's client.

**Every value below is illustrative and synthetic.** The fixtures are invented and generated
deterministically, with opaque ids (`c_rc_…`, `c_dl_…`) and declared categorical fields only.
They contain no names, scores, notes, compensation or free text, and they say nothing about any
real employer or service. **No production readiness is claimed.** Production stays refused
(`PRODUCTION_ENABLED = false`), and the real `read-api` source fails closed with
`source_unavailable`. The acceptance suite asserts this for the new apps too.

## Run

```bash
pnpm install --frozen-lockfile
pnpm exec vitest run --project lifecycle-mcp apps/lifecycle-mcp/test/acceptance.test.ts
pnpm lint && pnpm typecheck && pnpm test && pnpm build   # full gate, as CI runs it
```

The clock is fixed: `as_of` = `2026-10-30T00:05:00Z`, and the synthetic watermark is
`2026-10-30T00:00:00Z`. Real time never affects the result.

## Fixtures (`src/sources/synthetic-data.ts`)

| App | Workflows (version) | Notes |
| --- | --- | --- |
| `synthetic-recruiting` | `headcount-request`, `requisition`, `application`, `interview-loop`, `assessment` (all v1) | 42 headcount requests. Each requisition has 10–14 applications; about 60% reach an interview loop. Each loop has 3 parallel `assessment` tracks (`skills`, `collaboration`, `domain`). |
| `synthetic-delivery` | `service-rollout` v1 and v2, `regional-deployment` v1 | 130 rollouts per version. Each rollout has 3–4 sequential regional children. v2 adds an automated `bake` stage. |

Interview-loop lifecycle: `defined → staffing → scheduling [→ on_hold → scheduling#2] →
conducting → feedback → debrief → decided`. `conducting` waits for the last of the three track
interviews, and `feedback` waits for the last scorecard. Withdrawal (the applicant leaves) and
cancellation (the requisition closes) stop the loop as `interrupted` and cancel the open tracks.
Rejection is a decision outcome. A no-show interrupts the track interview, which is then
rescheduled (repeated visit).

Rollouts follow `planned → build → verify [→ build#2 → verify#2] → (v2: bake) → rolling_out
[→ paused → rolling_out#2] → completed`. A failed regional canary is retried once. A second
failure rolls the region back and the rollout too, and the remaining regions are `skipped`.

Timelines are simulated to completion, then cut at the watermark. Cases still running at that
point are `open`, with an `active` interval (right-censored).

**Relations.** `syntheticRelations()` holds explicit fixture-only `child_of` links:
loop → application, assessment → loop, region → rollout and so on. `LifecycleReadSource`
exposes no relation graph, so no MCP tool can see them. `dependency_scope: child_dependencies`
returns `insufficient_evidence`, `plan.dependency_graph` is `"unsupported"`, and inputs shaped
like a nested graph are rejected. Loop-level and track-level aggregates still work, each as its
own unlinked population. No tool infers a critical path.

## Scenario 1: interview-loop dwell regression

```text
prompts/get investigate_bottleneck {app_id: synthetic-recruiting, workflow_key: interview-loop}
tools/list                                   -> plan_investigation, collect_investigation_evidence, … (all readOnlyHint)
tools/call list_workflow_definitions         -> 5 recruiting workflows
tools/call plan_investigation  {goal: investigate_bottleneck,
  cohorts: [{v1, 2026-08-01..2026-08-31}, {v1, 2026-09-01..2026-10-01}]}   -> data_queries_executed: 0
tools/call collect_investigation_evidence (same args)
```

Illustrative evidence (`evidence_id sha256:cb5a6d07…672f`, `checks.status: bounded_evidence`):

| Stage p50 (completed intervals) | cohort-1 Aug, n=58 | cohort-2 Sep, n=50 |
| --- | --- | --- |
| scheduling | 33.5 h | 26.8 h |
| conducting | 40.6 h | 41.4 h |
| **feedback (scorecard wait)** | **12.2 h** | **65.7 h** |
| debrief | 17.5 h | 16.9 h |
| on_hold | n/a | withheld (`small_cohort`, fewer than 5 loops) |

What the data supports: the observed `feedback` p50 is about 5× higher in the September cohort.
`scheduling` did not rise. That is an association between two start windows. It does not show
a cause, and it says nothing about a hiring decision or any individual. Both cohorts have every
case closed (`open_n` 0), so follow-up is complete for these windows. The fixture plants the
shift deliberately: loops starting on or after 2026-09-01 get slower scorecards. The test checks
that the evidence surfaces that shift and nothing more.

Caveats carried in the pack: `matched_cohorts: not_verified`, coverage unknown,
`completion_only_no_outcome_breakdown`, completed-only dwell, suppression, and `SYNTHETIC DATA`.

**Trailing 30 days (2026-09-30..2026-10-30).** n=66, completed 44, open 22 (right-censored).
Feedback is n=45 with 7 open. Scheduling has 4 open, which the server releases as `open_n: null`
because it is below k.

**Stale data.** With the clock two hours past the watermark, the same request returns
`freshness.status: stale`, `checks.fresh: false` and `status: insufficient_evidence`.

## Scenario 2: service rollout v1 vs v2

`plan_investigation`/`collect_investigation_evidence` with `goal: compare_process_variants`,
`cohorts: [{v1, 2026-09-01..2026-10-01}, {v2, same window}]`
(`evidence_id sha256:df1e2768…c3a3`):

| | v1, n=51 | v2, n=46 |
| --- | --- | --- |
| rolling_out p50 | 8.8 h | 9.2 h |
| bake p50 | (no stage) | 1.5 h |
| paused | 6 rollouts, p50 5.4 h | withheld (`small_cohort`) |
| rolled back (fixture oracle only) | 9 | 3 |

Rollbacks count as "completed" (ended). The pack has no outcome breakdown, so the 9 vs 3 figure
comes from the test's fixture oracle, not from MCP. The direct `compare_workflow_variants`
(baseline 1, candidate 2) call returns `interpretation.causal: false` and these reasons:
"differences are not caused by the version alone" and "The versions define different stages;
compare end-to-end metrics only". Regional failures can be read through `get_funnel` on
`regional-deployment` grouped by `region`. Attributing parent rollbacks to regions needs
`child_dependencies`, which returns `insufficient_evidence`.

## Negative and integrity cases

All of these are in `test/acceptance.test.ts`:

- HTTP 401 without a token or with a dashboard-audience token; HTTP 403 for an unlisted `Origin`.
- `reader` grant: freshness is allowed, investigations are `forbidden`. A service token with an
  `admin` grant is capped at reader. A recruiting-only grant is `forbidden` on delivery, restricted
  and release apps.
- Tiny cohorts: a 2-day window gives `samples.n: null` and `insufficient_evidence`. The 3
  `hybrid` loops are withheld, and the next-smallest group is withheld as `complementary`.
- Malformed dates are rejected: `2026-02-30`, values without an offset, `yesterday`, reversed
  windows and future windows.
- Tampering: the client recomputes the content address of the received pack. Changing any value
  changes the hash, and swapping in a different `evidence_id` does not survive recomputation.
  Evidence ids, refs or entries passed back as tool input are rejected.
- Output size: every pack stays under `LIMITS.maxResultChars` (48,000), and the text summary
  stays under 500 chars.

`test/golden/acceptance-evidence.json` pins each pack's `evidence_id`, query ids, samples and
released dwell cells. Regenerate it only for an intended fixture or contract change, and review
the diff.

**Hash fix found by this suite.** Previously `collect_investigation_evidence` hashed its payload
before output parsing, and parsing reorders the keys of withheld cells. As a result, any pack
with a suppressed row had an `evidence_id` that clients could not reproduce. The bridge now
hashes the schema-normalized form, which is exactly what it returns. Packs without suppressed
rows keep their previous ids.

# Lifecycle hardening merge rehearsal (FLIG-40)

**Review-only, draft, non-deploying. integration-ready and production-safe are both BLOCKED.**
Do not merge this branch to `main` and do not deploy it. It exists to show that the open lifecycle
draft PRs compose, which migrations and flags result, and which review findings still block.

Passing tests here are not a release signal. The preflight verdict is BLOCKED because independent
reviews of #56 and #57 found open P1/P2 defects. Combined green tests do not clear a known finding.

## Baseline and head SHA dependency matrix

Base: `origin/main` at `0ff7b2564fa15a0fad17b562868a3d43a6015e24` (includes #41 admin, #42 rate
limits, #43 outbox tests, and earlier #36 tombstones, #52 lifecycle/MCP integration). Main was
merged in once; none of those commits are replayed from a PR branch.

| PR | Issue | Exact head merged | Based on | Adds | CI on that head | Independent review |
| --- | --- | --- | --- | --- | --- | --- |
| #56 | FLIG-39 | `99e30df5136ebb7ad1e9aba3f35f6c1c79a59bfb` | `8372f5e` | hotfix, migration `0032` (renumbered from `0031`) | check, pack-smoke pass | **2 P1 + 2 P2 open** (below) |
| #53 | FLIG-37 | `e7dec3aa54b5ae6de0e0281f9864fce491307b2b` | `53a9382` | Managed OAuth preflight, Access boundary | check, pack-smoke pass | not attested |
| #54 | FLIG-36 | `b8a739e4c7442bc4826c87f2f3aebb3c893b7ef6` | `53a9382` | privacy guard, D1 budgets, migration `0040` | check, pack-smoke pass | not attested |
| #55 | FLIG-38 | `951028423cf756f2c68033adb16badd6fd586c43` | `8372f5e` | preflight and release gates | check, harness-tests, preflight, pack-smoke pass | not attested |
| #57 | FLIG-35 | `351d696e1d66ced9470698a67f1d636cceefddaf` | `8372f5e` | erasure jobs, retention, migration `0041` | check, pack-smoke pass | **3 P1 open** (below) |

Merge order was #56, #53, #54, #55, #57, then main `0ff7b25`. Each PR head is an ancestor of the
rehearsal branch. **If any PR head moves, this matrix is stale.** #56 and #57 authors are revising;
refresh by re-running the replay below against the new heads and re-record this table.

Rehearsal code head verified: `9d61edffa0f2d50565688f66e7e1c968f8b77a9f`. The PR head will be
later by documentation commits only.

## Migration order

`0001, 0002, 0003, 0004, 0005, 0006, 0010, 0020, 0030, 0031` (main), then `0032_lifecycle_rebuild_staging`
(#56), `0040_lifecycle_privacy_budget` (#54), `0041_lifecycle_erasure_retention` (#57). No duplicate
numbers. All 13 apply in order to a blank in-memory SQLite database (preflight `d1-migrations`).
All three new migrations only add tables and indexes. `0031` tombstones are untouched and
`lifecycle_snapshot_tombstones` is never dropped or rewritten.

## Conflicts resolved

- `lifecycle-serving/routes.ts` and `lifecycle-serving-api.test.ts` (#54 vs main): the legacy
  `summaries/stages` and `summaries/outcomes` handlers stay privacy-gated (#54: 503 after
  authorization, no aggregate body). The `0031` tombstone replay assertions
  (`upsertCase` returns `tombstoned`, case detail 404) are kept in the soft-delete test.
- `lifecycle-projection/store.ts` (#57 vs #56): #56 moved `canonical()` to `identity.ts`. The
  duplicate in `store.ts` is dropped and #57's imports point to `identity.ts`.
- `apps/flightdeck/wrangler.jsonc`: privacy and erasure/retention vars are both kept. All are
  default off (`disabled`, `deny`, `off`, `off`).
- `vitest.config.ts` (#56 sqlite project vs #43 outbox project): both projects kept.
- Preflight manifest and tests reconciled with the integrated tree: `0032` is a required migration,
  `0040`/`0041` stay anticipated, four new flags are registered default-off, the synthetic staging
  plan states them, and flag values may contain `_` (`dry_run`).
- `pnpm-lock.yaml` merged without conflict; `pnpm install --frozen-lockfile` passes.
- Not reconciled: the `ratelimits` opt-in binding from #42 is not registered in the preflight
  manifest, because the harness schema does not support that section. It is protective and
  commented out by default.

## Open blockers (record as P1 gates)

Recorded in `scripts/lifecycle-preflight/findings.json` so the preflight cannot go green.

| Finding | Severity | PR | Gates blocked |
| --- | --- | --- | --- |
| R52-P1-FUTURE-EVENT-DISCARDED, R52-P1-SINGLETON-DWELL, R52-P2-CONFLICTING-OUTCOMES, R52-P2-FAILED-REBUILD-VISIBILITY | P1/P2 | #56 (original fix; stays open until an independent review attests the exact new head) | integration |
| R56-P1-OVERLAP-ACK-LOST: overlapping drain and rebuild lose an ACK | P1 | #56 | integration |
| R56-P1-SOURCE-ERASURE-RESURRECTION: source erasure can be resurrected by projection | P1 | #56 | `d1-retention`, `erasure-certificate` |
| R56-P2-STAGING-REINTRODUCES-RETAINED-ROWS: rebuild staging reintroduces retained rows | P2 | #56 | `d1-retention` |
| R56-P2-CASEDETAIL-CROSS-GENERATION: `caseDetail` can return a cross-generation response | P2 | #56 | integration |
| R57-P1-FUTURE-CHECKPOINTS: erasure proof accepts future-dated checkpoints | P1 | #57 | `d1-retention`, `erasure-certificate` |
| R57-P1-INFLIGHT-FORWARDING: in-flight forwarding of an erased case can outlive the proof | P1 | #57 | `d1-retention`, `erasure-certificate` |
| R57-P1-MOR-BYTES: erasure proof does not cover MOR (merge-on-read) bytes | P1 | #57 | `d1-retention`, `erasure-certificate` |

**Erasure production gate: BLOCKED.** The independent review of #57 found three unresolved
erasure-proof defects (future-dated checkpoints, in-flight forwarding, MOR bytes), and the #56
review found a source-erasure resurrection. The authors are updating #56 and #57. Until each is
fixed and an independent review names the exact new head, treat erasure and retention as unsafe
to enable. Keep `LIFECYCLE_ERASURE_MODE=off` and `LIFECYCLE_RETENTION_MODE=off`.

Also blocking production-safe, independent of findings:

- `source-completeness`: `PRODUCTION_ENABLED = false`.
- No live attestation for Access, OAuth, Basin, erasure certificate, audit retention or rollback
  rehearsal (`unknown`). No live Access, Basin, OAuth or reconciliation receipts exist.
- The preflight never calls a remote service; `production-safe` also needs a `staging` config.

## Verification at `9d61edf` (local, results from this rehearsal)

| Step | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | pass |
| `pnpm lint` | pass (412 files) |
| `pnpm typecheck` | pass |
| `pnpm test` | pass: 82 files, 1158 tests |
| `pnpm build` | pass |
| `pnpm smoke:pack` | pass |
| `pnpm test:integration` (synthetic) | pass: 3 files, 43 tests |
| preflight harness (`node --test scripts/lifecycle-preflight/test/*.test.mjs`) | pass: 63 tests |
| preflight `--run all` with synthetic staging config | exit 0; **integration-ready: BLOCKED** (`open-critical-findings`, `privacy-k-floor`); **production-safe: BLOCKED** |

These pass because the tests are synthetic and the open findings are not covered by them. They are
not evidence that the defects above are absent. The test run prints Cloudflare vitest-plugin
"Expected global Vitest state" noise; the suite still exits 0.

## Replay

```bash
git fetch origin
git worktree add -b integration/FLIG-40-lifecycle-hardening-rehearsal ~/work/flightdeck/FLIG-40-rehearsal origin/main && cd ~/work/flightdeck/FLIG-40-rehearsal
# merge each exact head, in order. Replace the SHAs with the heads from the matrix.
git merge --no-ff 99e30df5136ebb7ad1e9aba3f35f6c1c79a59bfb   # #56 FLIG-39
git merge --no-ff e7dec3aa54b5ae6de0e0281f9864fce491307b2b   # #53 FLIG-37
git merge --no-ff b8a739e4c7442bc4826c87f2f3aebb3c893b7ef6   # #54 FLIG-36
git merge --no-ff 951028423cf756f2c68033adb16badd6fd586c43   # #55 FLIG-38
git merge --no-ff 351d696e1d66ced9470698a67f1d636cceefddaf   # #57 FLIG-35
```

Resolve as in "Conflicts resolved", then:

```bash
pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test \
  && pnpm build && pnpm smoke:pack && pnpm test:integration
node --disable-warning=ExperimentalWarning --test "scripts/lifecycle-preflight/test/*.test.mjs"
node --disable-warning=ExperimentalWarning scripts/lifecycle-preflight.mjs --run all \
  --config scripts/lifecycle-preflight/fixtures/synthetic-staging.json
```

Expect migration numbers to stay unique, and the verdicts to stay BLOCKED while any entry in
`findings.json` is open. A revised #56 or #57 should land with its findings marked `resolved`,
regression tests present and an independent review of the exact commit; only then re-evaluate.

## Rollback

Nothing is deployed and no migration was applied to a live database, so the rollback is to close
this draft PR and delete the branch. `main` is never modified by this work.

If the rehearsal tree is ever applied to a **staging** D1 database:

1. Set `LIFECYCLE_ERASURE_MODE=off`, `LIFECYCLE_RETENTION_MODE=off`,
   `LIFECYCLE_PRIVACY_MODE=disabled`, `LIFECYCLE_MCP_READ_ENABLED=0` and redeploy the previous
   Worker version.
2. Prefer a D1 Time Travel restore to just before the migrations. Otherwise drop the added objects in
   reverse order: `0041` (`lifecycle_erasure_jobs`, `lifecycle_erasure_events`,
   `lifecycle_retired_cases`, `lifecycle_retention_checkpoints`), `0040` (`lifecycle_privacy_*`
   tables and `lifecycle_privacy_cohort` index), `0032` (`*_staging` tables).
3. Keep `0031` and its tombstones. Dropping them would let erased cases be projected again. Retention
   compaction (`retention_expired`) and erasure are not reversible, so stay in `off` or `dry_run`
   until the findings above are resolved.

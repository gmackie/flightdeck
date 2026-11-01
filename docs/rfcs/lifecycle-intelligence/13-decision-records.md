# 13 Decision records

Status values: **Proposed** (this RFC; to be confirmed at the workshop), **Accepted**,
**Rejected**, **Deferred**. All are Proposed on 2026-10-31. Update the status in place and add the
date and issue or PR when one changes.

---

### D1 Three tiers, one direction of truth

- **Context.** Lifecycle facts originate in other systems. Flightdeck needs fast reads, an auditable
  record and safe repair.
- **Decision.** Producer (system of record) → Basin stream / Iceberg (raw evidence, append-only) →
  CaseDO + D1 (read model, disposable). Flightdeck never writes back and never invents facts.
- **Alternatives.** (a) D1 as the store of record: rejected, because the size limit and lack of an
  open format conflict with the "users can leave with their data" goal in the design doc. (b) Iceberg
  only, queried live: rejected for latency and cost (D13).
- **Consequences.** Replay must exist from day one (PR-09). Fixes go through corrections, not edits.

### D2 Wire contract is A's `LifecycleEventV1`, after normalization

- **Context.** A and B drafted incompatible vocabularies (Appendix A, G1).
- **Decision.** One vocabulary, exported from `@flightdeckhq/schema`. The proposed canonical names:
  `case.created|started|paused|resumed|completed|terminated|reopened`,
  `stage.entered|exited|skipped|blocked|unblocked|paused|resumed`, `object.linked|unlinked`,
  `event.corrected{retract|amend}`; fields `eventId`, `processId`, `processVersion`, `caseId`,
  `stageId`, `stageInstanceId`, `occurredAt`, `sourceSequence`, `source`, `reason`, `relations`,
  `dimensions`. B adapts with an exhaustive `fromWire`.
- **Alternatives.** Adopt B's present-tense names (`case.start`, `stage.enter`): rejected because A
  owns the strict wire schema and the ingest path. Two vocabularies with a translation layer at
  ingest: rejected, because every reader would need to know both.
- **Consequences.** Gates G1 and G2. B's README and tests change.
- **Sub-decisions for G1** (each Proposed): `reason` required on `stage.blocked`/`unblocked`;
  reserved `parent` relation type; new transition `case.migrated` (05 §5.4), or no migration
  support in v1.

### D3 No timestamp clamping for lifecycles

- **Context.** `main`'s `toRow` replaces timestamps more than 24 h old with `received_at`. Lifecycle
  backfills span years.
- **Decision.** Keep `occurredAt` as sent (≥ 2000-01-01); reject future skew over 5 min.
- **Consequences.** Lifecycle ingest must not share `ingestBatch`. Late data is normal and flagged
  (`late_arrival`), not altered.

### D4 Both-or-retry ingest

- **Decision.** 200 only when the stream and every CaseDO accepted; otherwise 503 and a retry with
  the same ids. All-or-nothing validation per batch.
- **Alternatives.** `main`'s best-effort fan-out: rejected (02 §2.2). Queues between ingest and
  CaseDOs: deferred. They add an operational component, and synchronous awaits fit the latency
  budget at expected volumes.
- **Consequences.** Ingest latency includes DO round trips; the 10-cases-per-batch limit bounds it.

### D5 CaseDO per case with full log; guarded D1 projection

- **Decision.** One DO per `(app, process, case)` keeps every distinct event; it re-folds on change
  and projects to D1 with a `projection_seq` guard.
- **Alternatives.** A per-process DO (hot shard, serialized cases); stateless fold from D1 rows
  (needs the full log in D1, too large).
- **Consequences.** A 2,000-event cap per case; child cases for bigger lifecycles.

### D6 Five-part time decomposition with precedence paused > blocked > working

- **Decision.** 04 §4.4. The parts always sum to elapsed time.
- **Alternatives.** Report pauses and blocks as independent overlapping totals: rejected, because
  the totals can't be stacked or compared.

### D7 Union for overlapping blocks, equal-split attribution

- **Decision.** 04 §4.5.
- **Alternatives.** Attribute overlap to the earliest block: rejected, because it is arbitrary and
  order-sensitive. Report raw sums as shares: rejected, because the shares can exceed 100%.

### D8 Censoring-aware durations

- **Decision.** Closed-only percentiles and a Kaplan–Meier median, with `n`, `n_closed`,
  `n_censored` and `n_excluded`. Maturity rules for cohorts.
- **Consequences.** Every duration response is larger; the UI must explain two numbers (11 §11.7).

### D9 Immutable, versioned definitions with canonical stages

- **Decision.** 05. Comparability classes `exact`, `merged`, `not_comparable`, and never silently
  pooled across them.
- **Consequences.** G5: the additions land in A's schema before it freezes, or are deferred to
  `schemaVersion: 2`.

### D10 Tree via `parent`, graph via typed relations; parallel work as child cases

- **Decision.** 05 §5.5–5.7.
- **Alternatives.** Parallel stage instances within one case: rejected, because they break the
  single-track decomposition and make "current stage" ambiguous.

### D11 Authorization through E's grants; suppression k = 5 / 10

- **Decision.** 06 §6.4. Lifecycle routes always enforce, whatever `READ_AUTHZ_MODE` says.
- **Consequences.** G4. Restricted processes get extra query rules and a read audit.

### D12 Opaque pseudonymous ids, no free text, no actors, no protected characteristics

- **Decision.** 06 §6.2–6.3.
- **Consequences.** Some questions ("which interviewer…") are deliberately unanswerable.

### D13 Dashboards never query Basin SQL

- **Decision.** 08 §8.1. Basin SQL is used for replay, reconciliation and async Explore only.
- **Consequences.** D1 aggregates and the 400-day read-model window bound interactive history; older
  analysis goes through Explore.

### D14 Read-only MCP over the same handlers

- **Decision.** 10 §10.5. No write tools, not even approval-gated (unlike old PR #12).

### D15 Stack only additive quantities

- **Decision.** 11 §11.2.

### D16 Ship dark: `LIFECYCLE_MODE=off|shadow|on` plus per-app capability

- **Decision.** 12 §12.1. A feature release requires gates G1–G8 (Appendix A).

---

## Open questions (to resolve at the workshop)

| Id | Question | Default if not resolved |
|---|---|---|
| OQ-1 | Should v1 support `case.migrated`, or should cases always finish on their pinned version? | Finish on the pinned version |
| OQ-2 | Business calendars: v1.1 or later? Which processes need them first (hiring SLAs in business days)? | Later; wall clock only |
| OQ-3 | Raw-tier retention and erasure: does Basin offer row deletes or rewrites, or do we need an external Iceberg engine job? Who runs it? | External job; restricted processes stay off until it exists (G7) |
| OQ-4 | Is k = 10 right for restricted processes in small organizations, or should hiring analytics require a minimum org size? | k = 10, plus the 28-day window rule |
| OQ-5 | Workflows vs cron for replay jobs? | Workflows if available in the deployment, otherwise cron |
| OQ-6 | Should the query-analytics worktree (`packages/lifecycle-queries`) become the Explore template layer? It needs an issue and owner. | Yes, after G6 |
| OQ-7 | Should D1 hold lifecycle tables at all for very large deployments, or move to a separate D1 database? | Same database, 2 GB budget, `li doctor` warning at 70% |
| OQ-8 | Close old stacked drafts #1–#18 now, or keep them for reference? | Owner decides; RFC recommends closing with a link to Appendix A |

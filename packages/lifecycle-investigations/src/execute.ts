import type { QueryAdapter } from "@flightdeckhq/lifecycle-queries";
import { check, InvestigationError } from "./errors.js";
import { acceptResult, InvalidResultError } from "./evidence.js";
import { interpret } from "./findings.js";
import { canonicalJson, digestOf } from "./hash.js";
import { isToken, planInvestigation } from "./plan.js";
import type {
  AuthorizeInvestigation,
  EntryStatus,
  EvidenceCache,
  EvidenceEntry,
  EvidenceMetadata,
  EvidencePack,
  EvidenceRow,
  EvidenceStore,
  HypothesisStatus,
  InvestigationCatalog,
  InvestigationPlan,
  InvestigationRequest,
  MissingEvidence,
  MissingReason,
  PlannedQuery,
} from "./types.js";

export interface ExecuteOptions {
  catalog: InvestigationCatalog;
  /** Already scoped, read-only adapter. Its own validation is not relied upon. */
  adapter: QueryAdapter;
  /** Required. Anything but an explicit allow for exactly this app denies, with zero queries. */
  authorize: AuthorizeInvestigation;
  now?: () => number;
  /** Reject execution if the recompiled plan differs from the plan an agent reviewed. */
  expectedPlanDigest?: string;
  /** Disabled by default. Keys include the authorized scope, catalog revision and the
   * caller's source revision/watermark token, so entries never cross principals or apps. */
  cache?: { store: EvidenceCache; sourceRevision: string; ttlSeconds: number };
  /** Optional caller-owned persistence of the serialized pack. */
  persist?: { store: EvidenceStore; ttlSeconds: number };
}

export interface ExecutionReport {
  started: number;
  answered: number;
  cacheHits: number;
  timedOut: number;
  failed: number;
  skipped: number;
  maxInFlight: number;
  stoppedEarly: null | "insufficient-population" | "deadline";
  persisted: boolean | null;
  elapsedMs: number;
}

type Accepted = ReturnType<typeof acceptResult>;
type Outcome = {
  status: EntryStatus;
  accepted: Accepted | null;
  denied?: boolean;
  cached?: boolean;
};

const delay = (ms: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), Math.max(0, ms));
  });
  return {
    promise,
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
};

/** Rebuild a minimal result from accepted aggregates so cached values hold nothing else. */
function cacheValue(planned: PlannedQuery, appId: string, accepted: Accepted) {
  const query = planned.query;
  return {
    metric: query.metric,
    metadata: {
      ...accepted.metadata,
      appId,
      definitionId: query.definitionId,
      metricVersion: query.metricVersion,
    },
    rows: accepted.rows.map((row) =>
      query.metric.kind === "comparison"
        ? {
            key: row.key,
            group: row.group,
            primary: row.sample,
            reference: row.reference,
            comparable: row.comparable,
            reason: row.reason,
            deltaP50Ms: row.deltaP50Ms,
          }
        : { key: row.key, group: row.group, ...row.sample },
    ),
  };
}

const isDenial = (error: unknown) =>
  !!error &&
  typeof error === "object" &&
  ((error as { code?: unknown }).code === "forbidden" ||
    (error as { status?: unknown }).status === 403);

/**
 * Authorizes, compiles and runs a bounded investigation, returning a deterministic evidence
 * pack. Contains no model calls. Throws InvestigationError("forbidden") on any denial.
 *
 * Timeouts race the adapter promise but cannot cancel its I/O. A timed-out query therefore
 * keeps its concurrency slot until the underlying promise settles, so in-flight adapter work
 * never exceeds `maxConcurrency`. Queries not started by the total deadline are skipped.
 */
export async function executeInvestigation(
  request: InvestigationRequest,
  options: ExecuteOptions,
): Promise<{ plan: InvestigationPlan; pack: EvidencePack; report: ExecutionReport }> {
  const now = options?.now ?? Date.now;
  const startedAt = performance.now();
  // Snapshot caller input before awaiting authorization; it cannot change scope mid-run.
  request = structuredClone(request);
  const catalog = structuredClone(options?.catalog);
  const deny = () => new InvestigationError("forbidden", "Not authorized for this investigation");
  if (!options || typeof options.authorize !== "function") throw deny();
  check(
    options.adapter && typeof options.adapter.query === "function",
    "invalid_options",
    "Missing query adapter",
  );
  check(
    request &&
      typeof request === "object" &&
      isToken(request.appId) &&
      isToken(request.definitionId),
    "invalid_request",
    "Invalid investigation scope",
  );

  let decision: Awaited<ReturnType<AuthorizeInvestigation>>;
  try {
    decision = await options.authorize({
      appId: request.appId,
      definitionId: request.definitionId,
      capability: "process:read",
      recipe: request.recipe,
    });
  } catch {
    throw deny();
  }
  if (decision?.allowed !== true || decision.appId !== request.appId || !isToken(decision.scopeKey))
    throw deny();
  const { appId, scopeKey } = decision;
  let active = true;
  const requireCurrentGrant = async () => {
    let current: Awaited<ReturnType<AuthorizeInvestigation>>;
    try {
      current = await options.authorize({
        appId,
        definitionId: request.definitionId,
        capability: "process:read",
        recipe: request.recipe,
      });
    } catch {
      denied = true;
      throw deny();
    }
    if (current?.allowed !== true || current.appId !== appId || current.scopeKey !== scopeKey) {
      denied = true;
      throw deny();
    }
  };

  const plan = planInvestigation(request, catalog, { now });
  check(
    options.expectedPlanDigest === undefined || options.expectedPlanDigest === plan.digest,
    "invalid_request",
    "Plan changed since it was reviewed",
  );
  const cache = options.cache;
  if (cache !== undefined)
    check(
      cache &&
        typeof cache.store?.get === "function" &&
        typeof cache.store?.set === "function" &&
        isToken(cache.sourceRevision) &&
        Number.isSafeInteger(cache.ttlSeconds) &&
        cache.ttlSeconds >= 1 &&
        cache.ttlSeconds <= 86_400,
      "invalid_options",
      "Invalid cache configuration",
    );
  const persist = options.persist;
  if (persist !== undefined)
    check(
      persist &&
        typeof persist.store?.put === "function" &&
        Number.isSafeInteger(persist.ttlSeconds) &&
        persist.ttlSeconds >= 60 &&
        persist.ttlSeconds <= 604_800,
      "invalid_options",
      "Invalid persistence configuration",
    );

  const { budget } = plan;
  const deadline = performance.now() + budget.totalTimeoutMs;
  const report: ExecutionReport = {
    started: 0,
    answered: 0,
    cacheHits: 0,
    timedOut: 0,
    failed: 0,
    skipped: 0,
    maxInFlight: 0,
    stoppedEarly: null,
    persisted: null,
    elapsedMs: 0,
  };
  const outcomes = new Map<string, Outcome>();
  const startedQueries = new Set<string>();
  let inFlight = 0,
    denied = false;

  const cacheKey = (planned: PlannedQuery) =>
    `fd-inv:v1:${digestOf({
      scopeKey,
      appId,
      definitionId: plan.scope.definitionId,
      catalogRevision: plan.scope.catalogRevision,
      catalogDigest: digestOf(catalog),
      sourceRevision: cache?.sourceRevision,
      query: planned.digest,
    })}`;

  async function load(planned: PlannedQuery, canContinue: () => boolean): Promise<Outcome> {
    await requireCurrentGrant();
    if (!canContinue()) return { status: "skipped", accepted: null };
    if (cache) {
      let value: unknown;
      try {
        value = await cache.store.get(cacheKey(planned));
      } catch {
        value = undefined;
      }
      if (value !== undefined && value !== null) {
        try {
          return {
            status: "ok",
            accepted: acceptResult(planned, value, catalog.registry, budget.maxRowsPerQuery),
            cached: true,
          };
        } catch {
          // A malformed or foreign cache entry is ignored, never trusted.
        }
      }
    }
    await requireCurrentGrant();
    if (!canContinue()) return { status: "skipped", accepted: null };
    const value = await options.adapter.query(structuredClone(planned.query));
    const accepted = acceptResult(planned, value, catalog.registry, budget.maxRowsPerQuery);
    if (cache && canContinue())
      try {
        await requireCurrentGrant();
        if (!canContinue()) return { status: "skipped", accepted: null };
        await cache.store.set(
          cacheKey(planned),
          cacheValue(planned, appId, accepted),
          cache.ttlSeconds,
        );
      } catch (error) {
        if (denied) throw error;
        // Cache writes are best effort.
      }
    return { status: "ok", accepted };
  }

  function start(planned: PlannedQuery) {
    report.started++;
    startedQueries.add(planned.id);
    inFlight++;
    report.maxInFlight = Math.max(report.maxInFlight, inFlight);
    let underlying: Promise<Outcome>;
    let live = true;
    try {
      underlying = load(planned, () => live && active && performance.now() < deadline && !denied);
    } catch (error) {
      underlying = Promise.reject(error);
    }
    const settled = underlying.then(
      () => undefined,
      () => undefined,
    );
    void settled.then(() => {
      inFlight--;
    });
    const timer = delay(Math.min(budget.queryTimeoutMs, deadline - performance.now()));
    const result = Promise.race([
      underlying.then(
        (outcome): Outcome => outcome,
        (error): Outcome =>
          error instanceof InvalidResultError
            ? { status: "invalid_result", accepted: null }
            : { status: "failed", accepted: null, denied: isDenial(error) },
      ),
      timer.promise.then((): Outcome => ({ status: "timeout", accepted: null })),
    ]).finally(() => {
      live = false;
      timer.cancel();
    });
    return { result, settled };
  }

  async function run(queries: readonly PlannedQuery[]) {
    let next = 0;
    const workers = Array.from(
      { length: Math.min(budget.maxConcurrency, queries.length) },
      async () => {
        while (next < queries.length && active && !denied && performance.now() < deadline) {
          const planned = queries[next++] as PlannedQuery;
          const { result, settled } = start(planned);
          const outcome = await result;
          if (active) outcomes.set(planned.id, outcome);
          if (outcome.denied) denied = true;
          // Hold the slot until the adapter's promise settles, even after a timeout.
          await settled;
        }
      },
    );
    const remaining = delay(deadline - performance.now());
    const finished = await Promise.race([
      Promise.all(workers).then(() => "done" as const),
      remaining.promise,
    ]);
    remaining.cancel();
    if (finished === "timeout") {
      active = false;
      report.stoppedEarly = "deadline";
    }
  }

  const gates = plan.queries.filter((query) => query.role === "gate");
  await run(gates);
  if (denied) throw deny();
  const insufficient = gates.some((query) => {
    const outcome = outcomes.get(query.id);
    return (
      outcome?.status !== "ok" ||
      !outcome.accepted ||
      !outcome.accepted.metadata.sampleSize ||
      outcome.accepted.rows.every((row) => !row.sample?.sampleSize)
    );
  });
  if (insufficient) report.stoppedEarly ??= "insufficient-population";
  else if (report.stoppedEarly === null)
    await run(plan.queries.filter((query) => query.role === "evidence"));
  if (denied) throw deny();

  active = false;
  for (const id of startedQueries)
    if (!outcomes.has(id)) outcomes.set(id, { status: "timeout", accepted: null });
  // Cached evidence and work completed before a revocation cannot escape after it.
  await requireCurrentGrant();
  const pack = buildPack(plan, outcomes, insufficient);
  for (const outcome of outcomes.values()) {
    if (outcome.cached) report.cacheHits++;
    if (outcome.status === "ok") report.answered++;
    else if (outcome.status === "timeout") report.timedOut++;
    else report.failed++;
  }
  report.skipped = plan.queries.length - outcomes.size;
  if (persist) {
    try {
      await persist.store.put(
        `${appId}/${pack.id}`,
        serializeEvidencePack(pack),
        persist.ttlSeconds,
      );
      report.persisted = true;
    } catch {
      report.persisted = false;
    }
  }
  report.elapsedMs = Math.max(0, performance.now() - startedAt);
  return { plan, pack, report };
}

const REASON: Record<EntryStatus, MissingReason | null> = {
  ok: null,
  failed: "query-failed",
  timeout: "timeout",
  invalid_result: "invalid-result",
  skipped: "skipped",
};

function buildPack(
  plan: InvestigationPlan,
  outcomes: ReadonlyMap<string, Outcome>,
  insufficient: boolean,
): EvidencePack {
  const entries = new Map<string, EvidenceEntry>();
  for (const planned of plan.queries) {
    const outcome = outcomes.get(planned.id);
    const accepted = outcome?.accepted ?? null;
    entries.set(planned.id, {
      ref: `q:${planned.id}`,
      queryId: planned.id,
      purpose: planned.purpose,
      arm: planned.arm,
      stageId: planned.stageId,
      queryDigest: planned.digest,
      status: outcome?.status ?? "skipped",
      resultDigest: accepted?.digest ?? null,
      metadata: (accepted?.metadata ?? null) as EvidenceMetadata | null,
      rows: (accepted?.rows ?? []) as EvidenceRow[],
    });
  }
  const answered = [...entries.values()].filter((entry) => entry.metadata);
  const watermarks = [
    ...new Set(answered.map((entry) => entry.metadata?.watermark as string)),
  ].sort();
  const asOf = Date.parse(plan.asOf);
  const watermark = watermarks[0] ?? null;
  const lagMs = watermark === null ? null : asOf - Date.parse(watermark);
  const stale =
    watermark === null ||
    (lagMs as number) > plan.policy.maxWatermarkLagMs ||
    Date.parse(watermark) < Date.parse(plan.window.to);

  const findings = interpret({ plan, entries, policy: plan.policy, stale });
  const hypotheses = plan.hypotheses.map((hypothesis) => {
    const related = findings.filter((finding) => finding.hypothesisId === hypothesis.id);
    let status: HypothesisStatus = "descriptive";
    if (hypothesis.id !== "context")
      status = related.some((finding) => finding.status === "observed")
        ? "supported"
        : related.length && related.every((finding) => finding.status === "not_observed")
          ? "not_supported"
          : "cannot_determine";
    return { ...hypothesis, status, findingIds: related.map((finding) => finding.id) };
  });

  const missing = new Map<string, MissingEvidence>();
  const addMissing = (item: MissingEvidence) => missing.set(`${item.ref}|${item.reason}`, item);
  for (const entry of entries.values()) {
    const reason = REASON[entry.status];
    if (reason) addMissing({ ref: entry.ref, reason });
    for (const row of entry.rows) {
      const samples = [row.sample, row.reference].filter(Boolean);
      if (samples.some((sample) => Object.values(sample?.suppression ?? {}).some(Boolean)))
        addMissing({ ref: row.ref, reason: "suppressed", stratum: row.group });
    }
  }
  for (const query of plan.queries.filter((item) => item.role === "gate")) {
    const entry = entries.get(query.id);
    if (entry?.status === "ok" && !entry.metadata?.sampleSize)
      addMissing({ ref: entry.ref, reason: "insufficient-population" });
  }
  for (const finding of findings)
    for (const reason of finding.reasons)
      addMissing({ ref: finding.id, reason, stratum: finding.stratum });

  const warnings = new Set(plan.warnings);
  if (stale) warnings.add("stale-watermark");
  if (watermarks.length > 1) warnings.add("inconsistent-watermark");
  if (insufficient) warnings.add("insufficient-population");
  if (answered.some((entry) => entry.metadata?.truncated)) warnings.add("truncated-result");
  if (answered.some((entry) => entry.metadata?.coverage.ratio === null))
    warnings.add("coverage-unknown");
  if ([...entries.values()].some((entry) => entry.status !== "ok"))
    warnings.add("partial-evidence");

  const determinable = findings.some((finding) => finding.status !== "cannot_determine");
  const body = {
    schema: "flightdeck.evidence-pack.v1" as const,
    status:
      stale || insufficient || !determinable
        ? ("cannot_determine" as const)
        : warnings.has("partial-evidence")
          ? ("partial" as const)
          : ("complete" as const),
    recipe: plan.recipe,
    question: plan.question,
    planDigest: plan.digest,
    scope: plan.scope,
    knowledge: {
      asOf: plan.asOf,
      watermark,
      distinctWatermarks: watermarks.length,
      lagMs,
      stale,
      maturity: [
        {
          arm: "current" as const,
          window: plan.window,
          maturityMs: asOf - Date.parse(plan.window.to),
        },
        ...(plan.baselineWindow
          ? [
              {
                arm: "baseline" as const,
                window: plan.baselineWindow,
                maturityMs: asOf - Date.parse(plan.baselineWindow.to),
              },
            ]
          : []),
      ],
    },
    cohort: plan.cohort,
    baselineCohort: plan.baselineCohort,
    evidence: [...entries.values()],
    findings,
    hypotheses,
    alternatives: plan.alternatives,
    confounders: plan.alternatives,
    unsupportedClaims: [
      "Causal effects, statistical significance and confidence intervals are not estimated.",
      "Stage medians cannot be summed into end-to-end duration or a dependency critical path.",
      "Arrival counts and open age do not establish service capacity or a capacity forecast.",
      "Suppressed, absent or unknown statistics cannot be reconstructed or treated as zero.",
    ],
    missing: [...missing.values()].sort((a, b) =>
      `${a.ref}|${a.reason}` < `${b.ref}|${b.reason}` ? -1 : 1,
    ),
    warnings: [...warnings].sort(),
    safeguards: plan.safeguards,
    policy: plan.policy,
    limits: {
      plannedQueries: plan.queries.length,
      answeredQueries: answered.length,
      costUnits: plan.queries.reduce((total, query) => total + query.costUnits, 0),
    },
  };
  // Round-trip through canonical JSON so the returned pack equals its serialized form.
  const normalized = JSON.parse(canonicalJson(body)) as typeof body;
  const digest = digestOf(normalized);
  return { ...normalized, id: `ep_${digest.slice(0, 32)}`, digest };
}

export function serializeEvidencePack(pack: EvidencePack): string {
  return canonicalJson(pack);
}

/** Parses a persisted pack and verifies its digest; throws on tampering or wrong schema. */
export function parseEvidencePack(json: string): EvidencePack {
  let value: EvidencePack;
  try {
    value = JSON.parse(json) as EvidencePack;
  } catch {
    throw new InvestigationError("invalid_request", "Invalid evidence pack");
  }
  check(
    value && typeof value === "object" && value.schema === "flightdeck.evidence-pack.v1",
    "invalid_request",
    "Invalid evidence pack",
  );
  const { id, digest, ...body } = value;
  const actual = digestOf(body);
  check(
    digest === actual && id === `ep_${actual.slice(0, 32)}`,
    "invalid_request",
    "Evidence pack digest mismatch",
  );
  return value;
}

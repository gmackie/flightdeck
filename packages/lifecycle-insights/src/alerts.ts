import type {
  Alert,
  AlertEvaluation,
  Cell,
  Drilldown,
  EvaluationContext,
  Rule,
  Snapshot,
} from "./types.js";
import {
  canonical,
  checkSnapshot,
  normalizedFilter,
  selectCells,
  validContract,
  validPolicy,
  validSelection,
  validWindow,
} from "./validation.js";

const metrics = new Set([
  "p90-current-dwell",
  "stuck-open-count",
  "aged-backlog-count",
  "throughput-drop",
  "rejection-share",
  "cancellation-share",
  "capacity-saturation",
  "sla-breach-share",
]);
const nonnegative = (n: number) => Number.isFinite(n) && n >= 0;
function validRule(r: Rule, context: EvaluationContext): boolean {
  if (
    !validPolicy(context.policy) ||
    !validContract(r.contract) ||
    !validSelection(r.selection, context.policy)
  )
    return false;
  if (
    !r.id ||
    r.id.length > 200 ||
    !r.ownerRef ||
    r.ownerRef.length > 200 ||
    !Number.isSafeInteger(r.version) ||
    r.version < 1 ||
    !["info", "warning", "critical"].includes(r.severity) ||
    !metrics.has(r.metric) ||
    !validWindow(r.window) ||
    !nonnegative(r.threshold) ||
    !nonnegative(r.cooldownMs) ||
    !Number.isSafeInteger(r.minimumSamples) ||
    r.minimumSamples < 1 ||
    !Number.isSafeInteger(r.minimumCohort) ||
    r.minimumCohort < 2
  )
    return false;
  if (
    ["rejection-share", "cancellation-share", "sla-breach-share", "throughput-drop"].includes(
      r.metric,
    ) &&
    r.threshold > 1
  )
    return false;
  if (
    ["stuck-open-count", "aged-backlog-count", "sla-breach-share"].includes(r.metric) &&
    (r.ageThresholdMs === undefined || !nonnegative(r.ageThresholdMs))
  )
    return false;
  if (r.metric === "throughput-drop") {
    if (
      !r.baselineWindow ||
      !validWindow(r.baselineWindow) ||
      r.baselineWindow.end > r.window.start ||
      r.baselineWindow.end - r.baselineWindow.start !== r.window.end - r.window.start
    )
      return false;
  } else if (r.baselineWindow !== undefined) return false;
  return true;
}

/** Stable across rolling windows; change any semantic configuration only with a new version. */
export function alertKey(rule: Rule): string {
  return canonical({
    ruleId: rule.id,
    version: rule.version,
    contract: rule.contract,
    selection: { ...rule.selection, filters: normalizedFilter(rule.selection.filters) },
    metric: rule.metric,
    threshold: rule.threshold,
    ageThresholdMs: rule.ageThresholdMs,
    windowMs: rule.window.end - rule.window.start,
    baselineLagMs: rule.baselineWindow ? rule.window.start - rule.baselineWindow.end : null,
    severity: rule.severity,
    ownerRef: rule.ownerRef,
    minimumSamples: rule.minimumSamples,
    minimumCohort: rule.minimumCohort,
    cooldownMs: rule.cooldownMs,
  });
}
export function drilldown(snapshot: Snapshot, rule: Pick<Rule, "selection">): Drilldown {
  return {
    snapshotId: snapshot.id,
    scope: snapshot.scope,
    selection: rule.selection,
    window: snapshot.window,
    asOf: snapshot.asOf,
    watermark: snapshot.watermark,
  };
}
const sum = (cells: readonly Cell[], read: (c: Cell) => number) =>
  cells.reduce((n, c) => n + read(c), 0);

/** Deterministic: no wall clock, IO, mutation, persistence, or notifications. */
export function evaluateRule(input: {
  rule: Rule;
  current: Snapshot;
  baseline?: Snapshot;
  context: EvaluationContext;
  previous?: Alert;
}): AlertEvaluation {
  const { rule: r, current, baseline, context, previous } = input;
  const blocked = (...reasons: string[]): AlertEvaluation => ({ status: "blocked", reasons });
  if (!validRule(r, context)) return blocked("invalid-rule");
  const errors = checkSnapshot(current, r.contract, r.window, context);
  if (errors.length) return blocked(...errors);
  if (
    [
      "p90-current-dwell",
      "stuck-open-count",
      "aged-backlog-count",
      "capacity-saturation",
      "sla-breach-share",
    ].includes(r.metric) &&
    current.watermark < context.asOf
  )
    return blocked("incomplete-point-in-time-watermark");
  const minimum = Math.max(context.policy.minimumCohort, r.minimumCohort);
  const selected = selectCells(current, r.selection, minimum);
  if (selected.reasons.length) return blocked(...selected.reasons);
  const cells = selected.cells;
  let value: number;
  let samples: number;
  switch (r.metric) {
    case "p90-current-dwell": {
      // Percentiles are not additive. The producer must supply a single preaggregated cohort.
      if (cells.length !== 1) return blocked("non-mergeable-quantile");
      const dwell = cells[0]?.currentDwell;
      samples = dwell?.n ?? 0;
      value = dwell?.p90Ms ?? 0;
      break;
    }
    case "stuck-open-count":
    case "aged-backlog-count":
    case "sla-breach-share": {
      const field =
        r.metric === "stuck-open-count"
          ? "stuckOpen"
          : r.metric === "aged-backlog-count"
            ? "agedBacklog"
            : "slaBreach";
      if (cells.some((c) => c[field].thresholdMs !== r.ageThresholdMs))
        return blocked("threshold-definition-mismatch");
      samples = sum(cells, (c) => c[field].eligible);
      value = sum(cells, (c) => c[field].count);
      if (r.metric === "sla-breach-share") {
        if (!samples) return blocked("zero-denominator");
        value /= samples;
      }
      break;
    }
    case "throughput-drop": {
      if (!baseline || !r.baselineWindow) return blocked("missing-baseline");
      const baselineErrors = checkSnapshot(baseline, r.contract, r.baselineWindow, context);
      if (baselineErrors.length) return blocked(...baselineErrors);
      if (canonical(baseline.stageMapping) !== canonical(current.stageMapping))
        return blocked("stage-mapping-drift");
      const selectedBaseline = selectCells(baseline, r.selection, minimum);
      if (selectedBaseline.reasons.length) return blocked(...selectedBaseline.reasons);
      const strata = (items: readonly Cell[]) =>
        items.map((c) => canonical([c.variant, c.dimensions])).sort();
      if (canonical(strata(cells)) !== canonical(strata(selectedBaseline.cells)))
        return blocked("baseline-cohort-drift");
      const completed = sum(cells, (c) => c.completed);
      const before = sum(selectedBaseline.cells, (c) => c.completed);
      if (!before) return blocked("zero-denominator");
      if (before < Math.max(r.minimumSamples, minimum))
        return blocked("insufficient-baseline-samples");
      // A zero-completion current window is meaningful: sample eligibility is the cohort size.
      samples = sum(cells, (c) => c.cohortSize);
      value = (before - completed) / before;
      break;
    }
    case "rejection-share":
    case "cancellation-share": {
      samples = sum(cells, (c) => c.outcomes.total);
      if (!samples) return blocked("zero-denominator");
      value =
        sum(cells, (c) =>
          r.metric === "rejection-share" ? c.outcomes.rejected : c.outcomes.cancelled,
        ) / samples;
      break;
    }
    case "capacity-saturation": {
      samples = sum(cells, (c) => c.cohortSize);
      const available = sum(cells, (c) => c.capacity.available);
      if (!available) return blocked("zero-denominator");
      value = sum(cells, (c) => c.capacity.used) / available;
      break;
    }
  }
  if (!Number.isFinite(value) || !Number.isSafeInteger(samples)) return blocked("numeric-overflow");
  if (samples < Math.max(r.minimumSamples, minimum)) return blocked("insufficient-samples");
  const key = alertKey(r);
  const baselineRef =
    baseline && r.metric === "throughput-drop" ? drilldown(baseline, r) : undefined;
  if (previous) {
    if (previous.key !== key || previous.ruleVersion !== r.version || previous.ruleId !== r.id)
      return blocked("previous-alert-version-or-scope-mismatch");
    if (
      !Number.isFinite(previous.lastEvaluatedAt) ||
      previous.lastEvaluatedAt > context.asOf ||
      previous.openedAt > previous.lastEvaluatedAt ||
      previous.lastEmittedAt > previous.lastEvaluatedAt ||
      (previous.acknowledged && previous.acknowledged.at > context.asOf)
    )
      return blocked("out-of-order-evaluation");
    if (previous.lastEvaluatedAt === context.asOf) {
      if (
        previous.drilldown.snapshotId !== current.id ||
        previous.value !== value ||
        previous.drilldown.watermark !== current.watermark ||
        previous.baselineDrilldown?.snapshotId !== baselineRef?.snapshotId
      )
        return blocked("conflicting-replay");
      return { status: "evaluated", transition: "unchanged", emit: false, value, alert: previous };
    }
  }
  const breached = value > r.threshold;
  const ref = drilldown(current, r);
  if (!breached) {
    if (!previous) return { status: "evaluated", transition: "unchanged", emit: false, value };
    return {
      status: "evaluated",
      transition: previous.status === "open" ? "cleared" : "unchanged",
      emit: false,
      value,
      alert: {
        ...previous,
        status: "cleared",
        value,
        clearedAt: previous.clearedAt ?? context.asOf,
        lastEvaluatedAt: context.asOf,
        drilldown: ref,
        ...(baselineRef ? { baselineDrilldown: baselineRef } : {}),
      },
    };
  }
  const reopening = previous?.status === "cleared";
  const emit = !previous || context.asOf - previous.lastEmittedAt >= r.cooldownMs;
  const { clearedAt: _clearedAt, acknowledged, ...active } = previous ?? {};
  const alert: Alert = {
    ...active,
    key,
    ruleId: r.id,
    ruleVersion: r.version,
    severity: r.severity,
    ownerRef: r.ownerRef,
    status: "open",
    openedAt: reopening || !previous ? context.asOf : previous.openedAt,
    lastEvaluatedAt: context.asOf,
    lastEmittedAt: emit ? context.asOf : (previous?.lastEmittedAt ?? context.asOf),
    occurrences: (previous?.occurrences ?? 0) + (!previous || reopening ? 1 : 0),
    value,
    drilldown: ref,
    ...(baselineRef ? { baselineDrilldown: baselineRef } : {}),
    ...(!reopening && acknowledged ? { acknowledged } : {}),
  };
  return {
    status: "evaluated",
    transition: !previous ? "opened" : reopening ? "reopened" : emit ? "updated" : "cooldown",
    emit,
    value,
    alert,
  };
}

/** Caller must authorize ownership and persist atomically; acknowledgment does not clear an alert. */
export function acknowledgeAlert(alert: Alert, ownerRef: string, at: number): Alert {
  if (
    !ownerRef ||
    ownerRef.length > 200 ||
    !Number.isFinite(at) ||
    at < alert.lastEvaluatedAt ||
    (alert.acknowledged && at < alert.acknowledged.at) ||
    alert.status !== "open"
  )
    throw new Error("invalid-acknowledgment");
  return { ...alert, acknowledged: { ownerRef, at } };
}

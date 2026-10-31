// Which required behaviours a dataset actually exercises, derived from the delivered stream.
import { INVALID_REASONS } from "./model.mjs";
import { deliveryReport } from "./simulate.mjs";
import { DAY } from "./util.mjs";

/** @returns {Record<string, number>} feature -> evidence count (0 means not exercised) */
export function coverage(records, reduction, summary) {
  const f = {};
  const apps = Object.values(summary);
  const sum = (fn) => apps.reduce((n, a) => n + fn(a), 0);
  const kindsOf = (a) => Object.entries(a.entities);
  const outcomeCount = (name) =>
    sum((a) => kindsOf(a).reduce((n, [, k]) => n + (k.outcomes[name] ?? 0), 0));

  f.processes = new Set(apps.flatMap((a) => a.processes)).size;
  f.parallelStagesOnOneEntity = sum((a) =>
    kindsOf(a).reduce((n, [, k]) => n + k.parallelStageEntities, 0),
  );
  f.concurrentSiblings = sum(
    (a) => kindsOf(a).filter(([, k]) => k.peakConcurrentPerParent > 1).length,
  );
  f.longDwellStages = sum((a) =>
    Object.values(a.stages).reduce(
      (n, s) =>
        n + (s.closedDwell.maxMs >= 14 * DAY ? 1 : 0) + (s.openDwell.maxMs >= 14 * DAY ? 1 : 0),
      0,
    ),
  );
  f.pausedEntities = sum((a) => kindsOf(a).filter(([, k]) => k.pausedMsTotal > 0).length);
  f.reopenedEntities = sum((a) => kindsOf(a).reduce((n, [, k]) => n + k.reopenedEntities, 0));
  f.repeatedAssessments = sum((a) => a.relations.supersedes ?? 0);
  f.delayedScorecards = sum((a) =>
    (a.stages["assessment/scorecard_pending"]?.closedDwell.maxMs ?? 0) >= 2 * DAY ? 1 : 0,
  );
  f.pendingApproval = sum((a) => a.stages["headcount_need/pending_approval"]?.open ?? 0);
  for (const o of ["rejected", "withdrawn", "cancelled"]) f[`terminal_${o}`] = outcomeCount(o);

  const d = deliveryReport(records);
  f.lateDeliveries = d.lateEvents;
  f.outOfOrderDeliveries = d.outOfOrderDeliveries;
  f.duplicateDeliveries = reduction.totals.duplicateDeliveries;
  f.corrections = reduction.totals.corrections;
  for (const r of INVALID_REASONS) f[`invalid_${r}`] = reduction.totals.invalid.byReason[r] ?? 0;
  return f;
}

export const missing = (cov) =>
  Object.entries(cov)
    .filter(([, n]) => n === 0)
    .map(([k]) => k);

import type {
  Cell,
  Contract,
  EvaluationContext,
  Filter,
  Policy,
  Selection,
  Snapshot,
  Window,
} from "./types.js";

type Shape = (value: unknown) => boolean;
const text: Shape = (v) => typeof v === "string" && v.length > 0 && v.length <= 200;
const finite: Shape = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const count: Shape = (v) => finite(v) && Number.isSafeInteger(v);
const bool: Shape = (v) => typeof v === "boolean";
const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
function object(fields: Record<string, Shape>, optional: readonly string[] = []): Shape {
  return (v) =>
    record(v) &&
    Object.keys(v).every((k) => Object.hasOwn(fields, k)) &&
    Object.entries(fields).every(
      ([k, check]) => (optional.includes(k) && v[k] === undefined) || check(v[k]),
    );
}
const dictionary =
  (check: Shape): Shape =>
  (v) =>
    record(v) && Object.entries(v).every(([k, item]) => text(k) && check(item));
const windowShape = object({ start: finite, end: finite });
const clockShape = object({ timeZone: text, calendar: text });
const unitsShape = object({
  duration: (v) => v === "ms",
  cost: text,
  rework: (v) => v === "count",
  capacity: text,
});
const scopeShape = object(
  {
    lifecycleId: text,
    populationId: text,
    kind: (v) => v === "case" || v === "stage",
    stageOccurrenceId: text,
  },
  ["stageOccurrenceId"],
);
const momentsShape = object({ n: count, sum: finite, sumSquares: finite });
const thresholdShape = object({ thresholdMs: finite, count, eligible: count });
const cellShape = object({
  id: text,
  variant: text,
  dimensions: dictionary(text),
  cohortSize: count,
  suppressed: bool,
  censored: count,
  paused: count,
  currentDwell: object({ n: count, p90Ms: (v) => v === null || finite(v) }),
  stuckOpen: thresholdShape,
  agedBacklog: thresholdShape,
  slaBreach: thresholdShape,
  completed: count,
  outcomes: object({ total: count, rejected: count, cancelled: count }),
  capacity: object({ used: finite, available: finite }),
  duration: momentsShape,
  cost: momentsShape,
  rework: momentsShape,
});
const snapshotShape = object({
  contractVersion: (v) => v === 1,
  id: text,
  sourceId: text,
  sourceVersion: text,
  definitionVersion: text,
  mappingVersion: text,
  scope: scopeShape,
  clock: clockShape,
  units: unitsShape,
  window: windowShape,
  asOf: finite,
  producedAt: finite,
  watermark: finite,
  basis: (v) => v === "event-time",
  intervalPolicy: (v) => v === "union-active-excluding-pauses",
  disjointCells: bool,
  overlappingIntervalsResolved: bool,
  stageMapping: dictionary(text),
  cells: (v) => Array.isArray(v) && v.every(cellShape),
});

export const validWindow = (v: Window): boolean => windowShape(v) && v.start < v.end;
export const sameWindow = (a: Window, b: Window): boolean => a.start === b.start && a.end === b.end;
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value))
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function validClock(clock: Contract["clock"]): boolean {
  if (!clockShape(clock)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: clock.timeZone });
    return true;
  } catch {
    return false;
  }
}
export function validContract(contract: Contract): boolean {
  return (
    object({
      sourceId: text,
      sourceVersion: text,
      definitionVersion: text,
      mappingVersion: text,
      scope: scopeShape,
      clock: clockShape,
      units: unitsShape,
    })(contract) &&
    validClock(contract.clock) &&
    (contract.scope.kind === "stage"
      ? !!contract.scope.stageOccurrenceId
      : contract.scope.stageOccurrenceId === undefined)
  );
}
export function validPolicy(policy: Policy): boolean {
  return (
    object({
      permittedSources: (v) => Array.isArray(v) && v.length > 0 && v.every(text),
      dimensions: dictionary((v) => Array.isArray(v) && v.length > 0 && v.every(text)),
      minimumCohort: count,
    })(policy) && policy.minimumCohort >= 2
  );
}
export function validSelection(selection: Selection, policy: Policy): boolean {
  if (
    !object({
      variant: text,
      filters: dictionary((v) => Array.isArray(v) && v.length > 0 && v.every(text)),
    })(selection)
  )
    return false;
  return Object.entries(selection.filters).every(
    ([key, values]) =>
      Object.hasOwn(policy.dimensions, key) &&
      values.every((v) => policy.dimensions[key]?.includes(v)),
  );
}
export function matches(cell: Cell, selection: Selection): boolean {
  return (
    cell.variant === selection.variant &&
    Object.entries(selection.filters).every(([k, v]) => v.includes(cell.dimensions[k] ?? ""))
  );
}
export function normalizedFilter(filters: Filter): Filter {
  return Object.fromEntries(
    Object.entries(filters).map(([k, values]) => [k, [...new Set(values)].sort()]),
  );
}
export function validateSnapshot(snapshot: unknown, context: EvaluationContext): readonly string[] {
  if (!validPolicy(context.policy) || !finite(context.asOf)) return ["invalid-policy-or-cutoff"];
  if (!snapshotShape(snapshot)) return ["invalid-snapshot-shape"];
  const s = snapshot as Snapshot;
  const errors: string[] = [];
  if (!context.policy.permittedSources.includes(s.sourceId)) errors.push("source-not-permitted");
  if (!validContract(satisfiesContract(s))) errors.push("invalid-contract");
  if (
    !validWindow(s.window) ||
    s.window.end > s.asOf ||
    s.watermark > s.asOf ||
    s.asOf !== context.asOf ||
    s.producedAt < s.asOf
  )
    errors.push("invalid-cutoff");
  if (s.watermark < s.window.end) errors.push("incomplete-watermark");
  if (!s.disjointCells || !s.overlappingIntervalsResolved) errors.push("ambiguous-intervals");
  const occurrences = Object.values(s.stageMapping);
  if (
    new Set(occurrences).size !== occurrences.length ||
    (s.scope.kind === "stage" && !occurrences.includes(s.scope.stageOccurrenceId ?? ""))
  )
    errors.push("ambiguous-stage-mapping");
  const ids = new Set<string>();
  const strata = new Set<string>();
  for (const c of s.cells) {
    const key = canonical([c.variant, c.dimensions]);
    if (ids.has(c.id) || strata.has(key)) errors.push("duplicate-aggregate-cell");
    ids.add(c.id);
    strata.add(key);
    if (
      canonical(Object.keys(c.dimensions).sort()) !==
        canonical(Object.keys(context.policy.dimensions).sort()) ||
      Object.entries(c.dimensions).some(([k, v]) => !context.policy.dimensions[k]?.includes(v))
    )
      errors.push("blocked-dimension");
    if (
      c.paused > c.censored ||
      c.censored > c.cohortSize ||
      c.completed > c.cohortSize ||
      c.completed + c.censored > c.cohortSize ||
      c.outcomes.total > c.completed ||
      c.outcomes.rejected + c.outcomes.cancelled > c.outcomes.total ||
      c.currentDwell.n > c.censored - c.paused ||
      (c.currentDwell.n === 0 ? c.currentDwell.p90Ms !== null : c.currentDwell.p90Ms === null)
    )
      errors.push("invalid-counts");
    for (const bucket of [c.stuckOpen, c.agedBacklog, c.slaBreach]) {
      if (bucket.count > bucket.eligible || bucket.eligible > c.cohortSize)
        errors.push("invalid-counts");
    }
    if (
      c.stuckOpen.eligible > c.censored - c.paused ||
      c.agedBacklog.eligible > c.censored - c.paused
    )
      errors.push("paused-stage-inclusion");
    // Moment fields must not encode an individual observation even in a large parent cohort.
    if (
      !c.suppressed &&
      [
        c.currentDwell.n,
        c.duration.n,
        c.cost.n,
        c.rework.n,
        c.outcomes.total,
        c.stuckOpen.eligible,
        c.agedBacklog.eligible,
        c.slaBreach.eligible,
      ].some((n) => n > 0 && n < context.policy.minimumCohort)
    )
      errors.push("small-measurement-cohort");
    for (const m of [c.duration, c.cost, c.rework]) {
      if (
        m.n > c.completed ||
        (m.n === 0 && (m.sum !== 0 || m.sumSquares !== 0)) ||
        m.sumSquares + Math.max(1, m.sumSquares) * 1e-10 < m.sum * (m.sum / (m.n || 1))
      )
        errors.push("invalid-moments");
    }
  }
  return [...new Set(errors)];
}
export function satisfiesContract(s: Snapshot): Contract {
  return {
    sourceId: s.sourceId,
    sourceVersion: s.sourceVersion,
    definitionVersion: s.definitionVersion,
    mappingVersion: s.mappingVersion,
    scope: s.scope,
    clock: s.clock,
    units: s.units,
  };
}
export function checkSnapshot(
  s: Snapshot,
  contract: Contract,
  window: Window,
  context: EvaluationContext,
): readonly string[] {
  const errors = validateSnapshot(s, context);
  if (errors.length) return errors;
  if (canonical(satisfiesContract(s)) !== canonical(contract)) return ["contract-drift"];
  if (!sameWindow(s.window, window)) return ["wrong-window"];
  return [];
}
export function selectCells(
  s: Snapshot,
  selection: Selection,
  minimum: number,
): { cells: readonly Cell[]; reasons: readonly string[] } {
  const cells = s.cells
    .filter((c) => matches(c, selection))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // Never drop hidden cells and then calculate a visible remainder.
  if (cells.some((c) => c.suppressed)) return { cells: [], reasons: ["suppressed-cohort"] };
  if (cells.some((c) => c.cohortSize < minimum)) return { cells: [], reasons: ["small-cohort"] };
  return { cells, reasons: cells.length ? [] : ["empty-cohort"] };
}

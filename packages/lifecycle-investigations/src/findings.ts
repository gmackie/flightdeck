import type { Dimension, Sample } from "@flightdeckhq/lifecycle-queries";
import type {
  EvidenceEntry,
  EvidenceRow,
  FindingCandidate,
  FindingStatus,
  InterpretationPolicy,
  InvestigationPlan,
  MissingReason,
} from "./types.js";

export interface InterpretContext {
  plan: InvestigationPlan;
  entries: ReadonlyMap<string, EvidenceEntry>;
  policy: InterpretationPolicy;
  stale: boolean;
}

type Stratum = Partial<Record<Dimension, string>>;
const STATUS_REASON: Record<EvidenceEntry["status"], MissingReason | null> = {
  ok: null,
  failed: "query-failed",
  timeout: "timeout",
  invalid_result: "invalid-result",
  skipped: "skipped",
};

export function formatMs(ms: number): string {
  if (ms >= 86_400_000) return `${(ms / 86_400_000).toFixed(1)}d`;
  if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${Math.round(ms)}ms`;
}
const percent = (ratio: number) => `${ratio >= 0 ? "+" : ""}${(ratio * 100).toFixed(1)}%`;
const stratumLabel = (stratum: Stratum) =>
  Object.entries(stratum)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([dimension, value]) => `${dimension}=${value}`)
    .join(",") || "all";
const unique = <T>(values: readonly T[]) => [...new Set(values)];

/** Reasons any finding using these entries cannot be determined, independent of rows. */
function entryReasons(context: InterpretContext, entries: readonly (EvidenceEntry | undefined)[]) {
  const reasons: MissingReason[] = [];
  const watermarks = new Set<string>();
  for (const entry of entries) {
    if (!entry) {
      reasons.push("skipped");
      continue;
    }
    const status = STATUS_REASON[entry.status];
    if (status) reasons.push(status);
    if (!entry.metadata) continue;
    watermarks.add(entry.metadata.watermark);
    const ratio = entry.metadata.coverage.ratio;
    if (ratio !== null && ratio < context.policy.minCoverageRatio) reasons.push("low-coverage");
    if (ratio === null) reasons.push("unknown-coverage");
    if (entry.metadata.truncated) reasons.push("truncated");
    const planned = context.plan.queries.find((query) => query.id === entry.queryId);
    if (planned && Date.parse(entry.metadata.watermark) < Date.parse(planned.query.to))
      reasons.push("incomplete-window");
  }
  if (context.stale) reasons.push("stale-watermark");
  if (watermarks.size > 1) reasons.push("inconsistent-watermark");
  return unique(reasons);
}

function sampleRef(row: EvidenceRow, sample: Sample | null) {
  return {
    ref: row.ref,
    sampleSize: sample?.sampleSize ?? null,
    observedCases: sample?.observedCases ?? null,
    censoredCases: sample?.censoredCases ?? null,
  };
}

type DwellView = { ok: true; p50: number; share: number } | { ok: false; reasons: MissingReason[] };
function dwellView(sample: Sample | null, policy: InterpretationPolicy): DwellView {
  if (!sample) return { ok: false, reasons: ["missing-stratum"] };
  if (sample.suppression.sample) return { ok: false, reasons: ["suppressed"] };
  if (sample.censoredCases === null || !sample.sampleSize)
    return { ok: false, reasons: ["suppressed"] };
  const share = sample.censoredCases / sample.sampleSize;
  if (share > policy.maxCensoredShare) return { ok: false, reasons: ["right-censoring"] };
  if (sample.p50Ms === null) return { ok: false, reasons: ["insufficient-sample"] };
  return { ok: true, p50: sample.p50Ms, share };
}

class Builder {
  readonly findings: FindingCandidate[] = [];
  constructor(private readonly context: InterpretContext) {}
  add(
    input: Omit<FindingCandidate, "id" | "uncertainty" | "reasons" | "inference" | "status"> & {
      status: FindingStatus;
      suffix: string;
      reasons?: readonly MissingReason[];
      samples?: FindingCandidate["uncertainty"]["samples"];
      notes?: readonly string[];
      inference?: FindingCandidate["inference"];
    },
  ) {
    const reasons = unique(input.reasons ?? []);
    const determinable = reasons.length === 0 && input.status !== "cannot_determine";
    const metadataRefs = unique(input.metadataRefs).sort();
    const approximation = unique(
      metadataRefs
        .map((ref) => this.context.entries.get(ref.slice(2))?.metadata?.approximation)
        .filter((value): value is string => typeof value === "string"),
    ).sort();
    this.findings.push({
      id: `f:${input.kind}:${input.hypothesisId}:${stratumLabel(input.stratum)}${input.suffix ? `:${input.suffix}` : ""}`,
      hypothesisId: input.hypothesisId,
      kind: input.kind,
      status: determinable ? input.status : "cannot_determine",
      // A cannot_determine finding never carries a quantitative statement or measure.
      statement: determinable
        ? input.statement
        : `Cannot determine ${input.kind} in ${stratumLabel(input.stratum)} (${(reasons.length ? reasons : ["insufficient-sample"]).join(", ")}).`,
      measure: determinable ? input.measure : null,
      stratum: input.stratum,
      evidenceRefs: unique(input.evidenceRefs).sort(),
      metadataRefs,
      uncertainty: {
        samples: input.samples ?? [],
        approximation,
        notes: [...(input.notes ?? [])],
      },
      reasons: determinable ? [] : reasons.length ? reasons : ["insufficient-sample"],
      inference: input.inference ?? "descriptive",
    });
  }
}

const entryRef = (id: string) => `q:${id}`;
const rowsFor = (entry: EvidenceEntry | undefined, caseMix: string) =>
  (entry?.status === "ok" ? entry.rows : []).filter((row) => row.group.caseMix === caseMix);
const maturityNote = (plan: InvestigationPlan) => {
  const asOf = Date.parse(plan.asOf);
  const current = formatMs(asOf - Date.parse(plan.window.to));
  if (!plan.baselineWindow)
    return `The newest cases had ${current} between window end and asOf to finish.`;
  const baseline = formatMs(asOf - Date.parse(plan.baselineWindow.to));
  return `Same asOf for both windows: current-window cases had at least ${current} to finish, baseline-window cases at least ${baseline}; censoring is reported per arm, not corrected.`;
};
const PARALLEL_NOTE =
  "Per-stage medians are compared, never summed: stages in different lanes can overlap in time.";

/** Ranks stages within one stratum by observed median dwell (H1) or open work (H2). */
function rankStages(
  context: InterpretContext,
  builder: Builder,
  hypothesisId: string,
  mode: "median" | "open-work",
) {
  const { plan, policy } = context;
  const stages = plan.queries.filter(
    (query) => query.purpose === "stage-dwell" && query.arm === "current",
  );
  const entries = stages.map((query) => context.entries.get(query.id));
  const baseReasons = entryReasons(context, entries);
  const metadataRefs = stages.map((query) => entryRef(query.id));
  const notes = [PARALLEL_NOTE];
  if (new Set(plan.stages.map((stage) => stage.lane)).size > 1)
    notes.push("This catalog has parallel lanes; stage dwell shares of cycle time are undefined.");
  for (const caseMix of plan.cohort.caseMix) {
    const stratum = { caseMix };
    const candidates: { stage: string; row: EvidenceRow; value: number }[] = [];
    const excluded: string[] = [];
    const reasons: MissingReason[] = [...baseReasons];
    const refs: string[] = [];
    const samples = [];
    for (const [index, query] of stages.entries()) {
      const [row] = rowsFor(entries[index], caseMix);
      if (!row) {
        excluded.push(query.stageId as string);
        continue;
      }
      refs.push(row.ref);
      samples.push(sampleRef(row, row.sample));
      if (mode === "median") {
        const view = dwellView(row.sample, policy);
        if (view.ok) candidates.push({ stage: query.stageId as string, row, value: view.p50 });
        else excluded.push(query.stageId as string);
      } else {
        const censored = row.sample?.censoredCases ?? null;
        // Unknown (suppressed) open counts could hide the true maximum: do not rank.
        if (censored === null) reasons.push("suppressed");
        else candidates.push({ stage: query.stageId as string, row, value: censored });
      }
    }
    candidates.sort((a, b) => b.value - a.value || (a.stage < b.stage ? -1 : 1));
    const [top, second] = candidates;
    if (!top || !second) reasons.push(refs.length ? "insufficient-sample" : "no-rows");
    const stageNotes = excluded.length
      ? [...notes, `Excluded (no determinable row; absence is not zero): ${excluded.join(", ")}.`]
      : notes;
    if (mode === "median") {
      const observed = !!top && !!second && top.value > second.value * (1 + policy.minEffectRatio);
      builder.add({
        kind: "stage-median-rank",
        hypothesisId,
        suffix: "",
        stratum,
        status: observed ? "observed" : "not_observed",
        statement:
          top && second
            ? `In ${stratumLabel(stratum)}, stage ${top.stage} has the highest observed median dwell (${formatMs(top.value)}) among ${candidates.length} determinable stages; next is ${second.stage} (${formatMs(second.value)}).`
            : `Stage median ranking in ${stratumLabel(stratum)}.`,
        measure: top ? { name: `p50Ms:${top.stage}`, value: top.value, unit: "ms" } : null,
        evidenceRefs: refs,
        metadataRefs,
        reasons,
        samples,
        notes: stageNotes,
      });
    } else {
      const observed = !!top && !!second && top.value > 0 && top.value > second.value;
      builder.add({
        kind: "stage-open-work-rank",
        hypothesisId,
        suffix: "",
        stratum,
        status: observed ? "observed" : "not_observed",
        statement:
          top && second
            ? `In ${stratumLabel(stratum)}, stage ${top.stage} holds the most right-censored (open) cases (${top.value}); next is ${second.stage} (${second.value}).`
            : `Open work ranking in ${stratumLabel(stratum)}.`,
        measure: top
          ? { name: `censoredCases:${top.stage}`, value: top.value, unit: "cases" }
          : null,
        evidenceRefs: refs,
        metadataRefs,
        reasons,
        samples,
        notes: stageNotes,
      });
    }
  }
}

/** Compare two dwell samples taken under the same asOf. Returns reasons or the delta. */
function compareDwell(
  context: InterpretContext,
  primary: Sample | null,
  reference: Sample | null,
): { reasons: MissingReason[]; delta: number | null; relative: number | null } {
  const a = dwellView(primary, context.policy),
    b = dwellView(reference, context.policy);
  const reasons = [...(a.ok ? [] : a.reasons), ...(b.ok ? [] : b.reasons)];
  if (!a.ok || !b.ok) return { reasons, delta: null, relative: null };
  if (Math.abs(a.share - b.share) > context.policy.maxCensoredShareGap)
    return { reasons: ["censoring-imbalance"], delta: null, relative: null };
  const delta = a.p50 - b.p50;
  return { reasons, delta, relative: b.p50 > 0 ? delta / b.p50 : delta === 0 ? 0 : null };
}

/** Exhaustive outcome shares for one group, or reasons they are unknown. */
function outcomeShares(
  entry: EvidenceEntry | undefined,
  match: (row: EvidenceRow) => boolean,
): {
  reasons: MissingReason[];
  shares: Record<string, number> | null;
  rows: EvidenceRow[];
  total: number;
} {
  const rows = (entry?.status === "ok" ? entry.rows : []).filter(match);
  if (!rows.length) return { reasons: ["missing-stratum"], shares: null, rows, total: 0 };
  // Outcomes partition cases, so absent keys are zero only if the result is complete.
  if (entry?.metadata?.truncated) return { reasons: ["truncated"], shares: null, rows, total: 0 };
  if (rows.some((row) => row.sample?.sampleSize == null))
    return { reasons: ["suppressed"], shares: null, rows, total: 0 };
  const total = rows.reduce((sum, row) => sum + (row.sample?.sampleSize ?? 0), 0);
  const shares: Record<string, number> = { open: 0, completed: 0, cancelled: 0, failed: 0 };
  for (const row of rows) shares[row.key] = (row.sample?.sampleSize ?? 0) / total;
  return { reasons: [], shares, rows, total };
}

function compareOutcomes(
  context: InterpretContext,
  builder: Builder,
  input: {
    hypothesisId: string;
    stratum: Stratum;
    suffix: string;
    label: string;
    current: ReturnType<typeof outcomeShares>;
    reference: ReturnType<typeof outcomeShares>;
    entries: (EvidenceEntry | undefined)[];
    worsening: boolean;
  },
) {
  const { current, reference, stratum } = input;
  const reasons = [
    ...entryReasons(context, input.entries),
    ...current.reasons,
    ...reference.reasons,
  ];
  let observed = false,
    statement = `Outcome shares for ${input.label} in ${stratumLabel(stratum)}.`,
    measure: FindingCandidate["measure"] = null;
  if (current.shares && reference.shares) {
    const open = Math.abs((current.shares.open ?? 0) - (reference.shares.open ?? 0));
    if (open > context.policy.maxCensoredShareGap) reasons.push("censoring-imbalance");
    const completed = (current.shares.completed ?? 0) - (reference.shares.completed ?? 0);
    const failed = (current.shares.failed ?? 0) - (reference.shares.failed ?? 0);
    const threshold = context.policy.minShareDifference;
    observed = input.worsening
      ? completed <= -threshold || failed >= threshold
      : Math.abs(completed) >= threshold || Math.abs(failed) >= threshold;
    measure = { name: "completedShareDifference", value: completed, unit: "ratio" };
    statement = `In ${stratumLabel(stratum)}, ${input.label}: completed share ${(current.shares.completed ?? 0).toFixed(3)} vs ${(reference.shares.completed ?? 0).toFixed(3)}, failed share ${(current.shares.failed ?? 0).toFixed(3)} vs ${(reference.shares.failed ?? 0).toFixed(3)} (open ${(current.shares.open ?? 0).toFixed(3)} vs ${(reference.shares.open ?? 0).toFixed(3)}).`;
  }
  builder.add({
    kind: "outcome-share-difference",
    hypothesisId: input.hypothesisId,
    suffix: input.suffix,
    stratum,
    status: observed ? "observed" : "not_observed",
    statement,
    measure,
    evidenceRefs: [...current.rows, ...reference.rows].map((row) => row.ref),
    metadataRefs: input.entries.filter(Boolean).map((entry) => (entry as EvidenceEntry).ref),
    reasons,
    samples: [...current.rows, ...reference.rows].map((row) => sampleRef(row, row.sample)),
    notes: [
      "Shares use exhaustive outcome rows of an untruncated result; any suppressed row makes the share unknown.",
      "Open cases are right-censored; a large open-share gap blocks the comparison.",
    ],
    inference: "observational-association",
  });
}

function countsByStratum(entry: EvidenceEntry | undefined, caseMixes: readonly string[]) {
  const counts = new Map<string, { row: EvidenceRow; n: number | null }>();
  for (const caseMix of caseMixes) {
    const [row] = rowsFor(entry, caseMix);
    if (row) counts.set(caseMix, { row, n: row.sample?.sampleSize ?? null });
  }
  return counts;
}

function dwellChanges(context: InterpretContext, builder: Builder) {
  const { plan, policy } = context;
  for (const stage of plan.stages) {
    const current = context.entries.get(`stage-dwell.current.${stage.id}`),
      baseline = context.entries.get(`stage-dwell.baseline.${stage.id}`);
    const base = entryReasons(context, [current, baseline]);
    for (const caseMix of plan.cohort.caseMix) {
      const [a] = rowsFor(current, caseMix),
        [b] = rowsFor(baseline, caseMix);
      const compared = compareDwell(context, a?.sample ?? null, b?.sample ?? null);
      const rel = compared.relative;
      const observed =
        compared.delta !== null &&
        (rel === null ? compared.delta > 0 : rel >= policy.minEffectRatio);
      builder.add({
        kind: "dwell-change",
        hypothesisId: "H1",
        suffix: stage.id,
        stratum: { caseMix },
        status: observed ? "observed" : "not_observed",
        statement:
          compared.delta !== null && a?.sample?.p50Ms != null && b?.sample?.p50Ms != null
            ? `In caseMix=${caseMix}, stage ${stage.id} observed median dwell was ${formatMs(a.sample.p50Ms)} in the current window vs ${formatMs(b.sample.p50Ms)} in the baseline window${rel === null ? "" : ` (${percent(rel)})`}.`
            : `Median dwell change for stage ${stage.id} in caseMix=${caseMix}.`,
        measure:
          compared.delta === null
            ? null
            : { name: "deltaP50Ms", value: compared.delta, unit: "ms" },
        evidenceRefs: [a?.ref, b?.ref].filter((ref): ref is string => !!ref),
        metadataRefs: [current?.ref, baseline?.ref].filter((ref): ref is string => !!ref),
        reasons: [...base, ...compared.reasons],
        samples: [a, b]
          .filter(Boolean)
          .map((row) => sampleRef(row as EvidenceRow, (row as EvidenceRow).sample)),
        notes: [maturityNote(plan), PARALLEL_NOTE],
      });
    }
  }
}

function caseMixShift(context: InterpretContext, builder: Builder) {
  const { plan } = context;
  const current = context.entries.get("case-counts.current"),
    baseline = context.entries.get("case-counts.baseline");
  const a = countsByStratum(current, plan.cohort.caseMix),
    b = countsByStratum(baseline, plan.baselineCohort?.caseMix ?? plan.cohort.caseMix);
  const reasons = entryReasons(context, [current, baseline]);
  const complete =
    a.size === plan.cohort.caseMix.length &&
    b.size === plan.cohort.caseMix.length &&
    [...a.values(), ...b.values()].every((item) => item.n !== null);
  const totalA = [...a.values()].reduce((sum, item) => sum + (item.n ?? 0), 0);
  const totalB = [...b.values()].reduce((sum, item) => sum + (item.n ?? 0), 0);
  for (const caseMix of plan.cohort.caseMix) {
    const x = a.get(caseMix),
      y = b.get(caseMix);
    const extra: MissingReason[] = !complete
      ? [x && y ? "suppressed" : "missing-stratum"]
      : totalA && totalB
        ? []
        : ["insufficient-sample"];
    const diff = complete && totalA && totalB ? (x?.n ?? 0) / totalA - (y?.n ?? 0) / totalB : null;
    builder.add({
      kind: "case-mix-shift",
      hypothesisId: "H2",
      suffix: "",
      stratum: { caseMix },
      status:
        diff !== null && Math.abs(diff) >= context.policy.minShareDifference
          ? "observed"
          : "not_observed",
      statement:
        diff === null
          ? `Case-mix share change for caseMix=${caseMix}.`
          : `caseMix=${caseMix} share of cases was ${((x?.n ?? 0) / totalA).toFixed(3)} in the current window vs ${((y?.n ?? 0) / totalB).toFixed(3)} in the baseline window.`,
      measure: diff === null ? null : { name: "shareDifference", value: diff, unit: "ratio" },
      evidenceRefs: [...a.values(), ...b.values()].map((item) => item.row.ref),
      metadataRefs: [current?.ref, baseline?.ref].filter((ref): ref is string => !!ref),
      reasons: [...reasons, ...extra],
      samples: [x, y].flatMap((item) => (item ? [sampleRef(item.row, item.row.sample)] : [])),
      notes: ["Shares require every requested stratum to be visible in both windows."],
    });
  }
}

function variantDifferences(context: InterpretContext, builder: Builder) {
  const { plan } = context;
  for (const stage of plan.stages) {
    const entry = context.entries.get(`stage-dwell.current.${stage.id}`);
    const base = entryReasons(context, [entry]);
    for (const caseMix of plan.cohort.caseMix) {
      const rows = rowsFor(entry, caseMix);
      const usable = rows
        .filter((row) => dwellView(row.sample, context.policy).ok)
        .sort(
          (a, b) =>
            (b.sample?.sampleSize ?? 0) - (a.sample?.sampleSize ?? 0) ||
            ((a.group.variantId ?? "") < (b.group.variantId ?? "") ? -1 : 1),
        );
      const reference = usable[0];
      const others = rows.filter((row) => row !== reference);
      if (!reference || !others.length) {
        builder.add({
          kind: "variant-dwell-difference",
          hypothesisId: "H1",
          suffix: stage.id,
          stratum: { caseMix },
          status: "cannot_determine",
          statement: `Variant dwell comparison for stage ${stage.id} in caseMix=${caseMix} needs at least two variants and one determinable reference.`,
          measure: null,
          evidenceRefs: rows.map((row) => row.ref),
          metadataRefs: entry ? [entry.ref] : [],
          reasons: [...base, rows.length ? "insufficient-sample" : "missing-stratum"],
          samples: rows.map((row) => sampleRef(row, row.sample)),
        });
        continue;
      }
      for (const row of others) {
        const compared = compareDwell(context, row.sample, reference.sample);
        const rel = compared.relative;
        builder.add({
          kind: "variant-dwell-difference",
          hypothesisId: "H1",
          suffix: `${stage.id}:${row.group.variantId}`,
          stratum: { caseMix, variantId: row.group.variantId },
          status:
            rel !== null && Math.abs(rel) >= context.policy.minEffectRatio
              ? "observed"
              : "not_observed",
          statement:
            compared.delta !== null && row.sample?.p50Ms != null && reference.sample?.p50Ms != null
              ? `In caseMix=${caseMix}, stage ${stage.id}: variant ${row.group.variantId} observed median dwell ${formatMs(row.sample.p50Ms)} vs reference variant ${reference.group.variantId} ${formatMs(reference.sample.p50Ms)}${rel === null ? "" : ` (${percent(rel)})`}.`
              : `Variant ${row.group.variantId} vs ${reference.group.variantId} for stage ${stage.id} in caseMix=${caseMix}.`,
          measure:
            compared.delta === null
              ? null
              : { name: "deltaP50Ms", value: compared.delta, unit: "ms" },
          evidenceRefs: [row.ref, reference.ref],
          metadataRefs: entry ? [entry.ref] : [],
          reasons: [...base, ...compared.reasons],
          samples: [row, reference].map((item) => sampleRef(item, item.sample)),
          notes: [
            "Reference variant is the largest determinable variant in the stratum.",
            "Variants are not randomly assigned; differences are associations within case mix.",
          ],
          inference: "observational-association",
        });
      }
    }
  }
  const entry = context.entries.get("outcomes.current");
  for (const caseMix of plan.cohort.caseMix) {
    const variants = unique(rowsFor(entry, caseMix).map((row) => row.group.variantId ?? "")).sort();
    const shares = variants.map((variantId) => ({
      variantId,
      ...outcomeShares(
        entry,
        (row) => row.group.caseMix === caseMix && row.group.variantId === variantId,
      ),
    }));
    const reference = shares
      .filter((item) => item.shares)
      .sort((a, b) => b.total - a.total || (a.variantId < b.variantId ? -1 : 1))[0];
    for (const item of shares) {
      if (item === reference) continue;
      compareOutcomes(context, builder, {
        hypothesisId: "H2",
        stratum: { caseMix, variantId: item.variantId },
        suffix: item.variantId,
        label: `variant ${item.variantId} vs ${reference ? `reference variant ${reference.variantId}` : "no determinable reference"}`,
        current: item,
        reference: reference ?? {
          reasons: ["insufficient-sample"],
          shares: null,
          rows: [],
          total: 0,
        },
        entries: [entry],
        worsening: false,
      });
    }
    if (variants.length < 2)
      builder.add({
        kind: "outcome-share-difference",
        hypothesisId: "H2",
        suffix: "",
        stratum: { caseMix },
        status: "cannot_determine",
        statement: `Variant outcome comparison in caseMix=${caseMix} needs at least two reported variants.`,
        measure: null,
        evidenceRefs: rowsFor(entry, caseMix).map((row) => row.ref),
        metadataRefs: entry ? [entry.ref] : [],
        reasons: [
          ...entryReasons(context, [entry]),
          variants.length ? "insufficient-sample" : "missing-stratum",
        ],
      });
  }
}

function interventionReview(context: InterpretContext, builder: Builder) {
  const { plan, policy } = context;
  for (const stage of plan.stages) {
    const entry = context.entries.get(`stage-comparison.current.${stage.id}`);
    const base = entryReasons(context, [entry]);
    for (const caseMix of plan.cohort.caseMix) {
      const [row] = rowsFor(entry, caseMix);
      const reasons: MissingReason[] = [...base];
      let compared: ReturnType<typeof compareDwell> = { reasons: [], delta: null, relative: null };
      if (!row) reasons.push("missing-stratum");
      else if (!row.comparable)
        reasons.push(row.reason === "suppressed" ? "suppressed" : "missing-stratum");
      else compared = compareDwell(context, row.sample, row.reference);
      const rel = compared.relative;
      builder.add({
        kind: "cohort-dwell-difference",
        hypothesisId: "H1",
        suffix: stage.id,
        stratum: { caseMix },
        status:
          compared.delta !== null &&
          (rel === null ? compared.delta < 0 : rel <= -policy.minEffectRatio)
            ? "observed"
            : "not_observed",
        statement:
          compared.delta !== null && row?.sample?.p50Ms != null && row.reference?.p50Ms != null
            ? `In caseMix=${caseMix}, stage ${stage.id}: cohort ${plan.cohort.id} observed median dwell ${formatMs(row.sample.p50Ms)} vs reference cohort ${plan.baselineCohort?.id} ${formatMs(row.reference.p50Ms)}${rel === null ? "" : ` (${percent(rel)})`}.`
            : `Cohort dwell comparison for stage ${stage.id} in caseMix=${caseMix}.`,
        measure:
          compared.delta === null
            ? null
            : { name: "deltaP50Ms", value: compared.delta, unit: "ms" },
        evidenceRefs: row ? [row.ref] : [],
        metadataRefs: entry ? [entry.ref] : [],
        reasons: [...reasons, ...compared.reasons],
        samples: row ? [sampleRef(row, row.sample), sampleRef(row, row.reference)] : [],
        notes: [
          "Same window and asOf for both cohorts; this is an observational association, not an effect estimate.",
          PARALLEL_NOTE,
        ],
        inference: "observational-association",
      });
    }
  }
  const current = context.entries.get("outcomes.current"),
    reference = context.entries.get("outcomes.reference");
  for (const caseMix of plan.cohort.caseMix)
    compareOutcomes(context, builder, {
      hypothesisId: "H2",
      stratum: { caseMix },
      suffix: "",
      label: `cohort ${plan.cohort.id} vs reference ${plan.baselineCohort?.id}`,
      current: outcomeShares(current, (row) => row.group.caseMix === caseMix),
      reference: outcomeShares(reference, (row) => row.group.caseMix === caseMix),
      entries: [current, reference],
      worsening: true,
    });
}

function arrivals(context: InterpretContext, builder: Builder) {
  const { plan, policy } = context;
  const current = context.entries.get("case-counts.current"),
    baseline = context.entries.get("case-counts.baseline");
  const a = countsByStratum(current, plan.cohort.caseMix),
    b = countsByStratum(baseline, plan.cohort.caseMix);
  const base = entryReasons(context, [current, baseline]);
  for (const caseMix of plan.cohort.caseMix) {
    const x = a.get(caseMix),
      y = b.get(caseMix);
    const reasons: MissingReason[] = [...base];
    if (!x || !y) reasons.push("missing-stratum");
    else if (x.n === null || y.n === null) reasons.push("suppressed");
    else if (y.n === 0) reasons.push("insufficient-sample");
    const rel = x?.n != null && y?.n ? (x.n - y.n) / y.n : null;
    builder.add({
      kind: "arrival-change",
      hypothesisId: "H1",
      suffix: "",
      stratum: { caseMix },
      status: rel !== null && rel >= policy.minEffectRatio ? "observed" : "not_observed",
      statement:
        rel !== null
          ? `caseMix=${caseMix}: ${x?.n} cases started in the current window vs ${y?.n} in the equal-length baseline window (${percent(rel)}).`
          : `Arrival change for caseMix=${caseMix}.`,
      measure: rel === null ? null : { name: "relativeChange", value: rel, unit: "ratio" },
      evidenceRefs: [x?.row.ref, y?.row.ref].filter((ref): ref is string => !!ref),
      metadataRefs: [current?.ref, baseline?.ref].filter((ref): ref is string => !!ref),
      reasons,
      samples: [x, y].flatMap((item) => (item ? [sampleRef(item.row, item.row.sample)] : [])),
      notes: ["Counts are case-start cohort membership, not per-case workload."],
    });
  }
}

function openAge(context: InterpretContext, builder: Builder) {
  const entry = context.entries.get("open-age.current");
  const base = entryReasons(context, [entry]);
  const rows = entry?.status === "ok" ? entry.rows : [];
  for (const caseMix of context.plan.cohort.caseMix) {
    const matched = rows.filter((item) => item.group.caseMix === caseMix);
    for (const row of matched.length ? matched : [undefined]) {
      const p90 = row?.sample?.p90Ms ?? null;
      const stratum = row ? { ...row.group } : { caseMix };
      builder.add({
        kind: "open-age",
        hypothesisId: "context",
        suffix: "",
        stratum,
        status: "observed",
        statement:
          p90 !== null && row?.sample?.p50Ms != null
            ? `In ${stratumLabel(stratum)}, ${row.sample.sampleSize} open cases have age p50 ${formatMs(row.sample.p50Ms)} and p90 ${formatMs(p90)} at asOf.`
            : `Open case age in ${stratumLabel(stratum)}.`,
        measure: p90 === null ? null : { name: "openAgeP90Ms", value: p90, unit: "ms" },
        evidenceRefs: row ? [row.ref] : [],
        metadataRefs: entry ? [entry.ref] : [],
        reasons: [
          ...base,
          ...(row ? (p90 === null ? ["suppressed" as const] : []) : ["missing-stratum" as const]),
        ],
        samples: row ? [sampleRef(row, row.sample)] : [],
        notes: ["Open age is right-censored: it is a lower bound on eventual duration."],
      });
    }
  }
}

function processHealth(context: InterpretContext, builder: Builder) {
  const { policy } = context;
  const counts = context.entries.get("case-counts.current");
  const base = entryReasons(context, [counts]);
  for (const row of counts?.status === "ok" ? counts.rows : []) {
    const n = row.sample?.sampleSize ?? null,
      open = row.sample?.censoredCases ?? null;
    const share = n && open !== null ? open / n : null;
    builder.add({
      kind: "open-share",
      hypothesisId: "H1",
      suffix: "",
      stratum: { ...row.group },
      status: share !== null && share >= policy.materialShare ? "observed" : "not_observed",
      statement:
        share !== null
          ? `In ${stratumLabel(row.group)}, ${open} of ${n} cases (${share.toFixed(3)}) are open at asOf.`
          : `Open share in ${stratumLabel(row.group)}.`,
      measure: share === null ? null : { name: "openShare", value: share, unit: "ratio" },
      evidenceRefs: [row.ref],
      metadataRefs: counts ? [counts.ref] : [],
      reasons: [...base, ...(share === null ? ["suppressed" as const] : [])],
      samples: [sampleRef(row, row.sample)],
      notes: [maturityNote(context.plan)],
    });
  }
  for (const caseMix of context.plan.cohort.caseMix)
    if (!rowsFor(counts, caseMix).length)
      builder.add({
        kind: "open-share",
        hypothesisId: "H1",
        suffix: "",
        stratum: { caseMix },
        status: "cannot_determine",
        statement: `Open share in caseMix=${caseMix}.`,
        measure: null,
        evidenceRefs: [],
        metadataRefs: counts ? [counts.ref] : [],
        reasons: [...base, "missing-stratum"],
      });
  const outcomes = context.entries.get("outcomes.current");
  const groups = new Map<string, Stratum>();
  for (const row of outcomes?.status === "ok" ? outcomes.rows : [])
    groups.set(JSON.stringify(Object.entries(row.group).sort()), row.group);
  for (const [identity, group] of [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const shares = outcomeShares(
      outcomes,
      (row) => JSON.stringify(Object.entries(row.group).sort()) === identity,
    );
    const terminal = shares.shares
      ? (shares.shares.failed ?? 0) + (shares.shares.cancelled ?? 0)
      : null;
    builder.add({
      kind: "terminal-outcome-share",
      hypothesisId: "H2",
      suffix: "",
      stratum: group,
      status: terminal !== null && terminal >= policy.materialShare ? "observed" : "not_observed",
      statement:
        terminal !== null
          ? `In ${stratumLabel(group)}, failed + cancelled share is ${terminal.toFixed(3)} of ${shares.total} cases.`
          : `Failed + cancelled share in ${stratumLabel(group)}.`,
      measure:
        terminal === null
          ? null
          : { name: "failedOrCancelledShare", value: terminal, unit: "ratio" },
      evidenceRefs: shares.rows.map((row) => row.ref),
      metadataRefs: outcomes ? [outcomes.ref] : [],
      reasons: [...entryReasons(context, [outcomes]), ...shares.reasons],
      samples: shares.rows.map((row) => sampleRef(row, row.sample)),
      notes: ["Open cases may still fail or be cancelled; shares are as of asOf."],
    });
  }
}

export function interpret(context: InterpretContext): FindingCandidate[] {
  const builder = new Builder(context);
  switch (context.plan.recipe.id) {
    case "process-health":
      processHealth(context, builder);
      openAge(context, builder);
      break;
    case "bottleneck-triage":
      rankStages(context, builder, "H1", "median");
      rankStages(context, builder, "H2", "open-work");
      openAge(context, builder);
      break;
    case "dwell-regression":
      dwellChanges(context, builder);
      caseMixShift(context, builder);
      break;
    case "variant-comparison":
      variantDifferences(context, builder);
      break;
    case "intervention-review":
      interventionReview(context, builder);
      break;
    case "capacity-risk":
      arrivals(context, builder);
      rankStages(context, builder, "H2", "open-work");
      openAge(context, builder);
      break;
  }
  const ids = new Set<string>();
  return builder.findings
    .filter((finding) => {
      if (ids.has(finding.id)) return false;
      ids.add(finding.id);
      return true;
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

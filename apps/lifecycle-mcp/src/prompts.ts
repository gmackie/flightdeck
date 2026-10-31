import { z } from "zod";

/**
 * Analysis prompt templates. A prompt only returns instructions: it reads no data and the server
 * calls no model. The client's agent gathers evidence with the read-only tools and interprets it.
 * Arguments are slugs, dates and versions, so no free text (or personal data) passes through.
 */

const slug = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const appId = z
  .string()
  .regex(/^[\w-]{3,64}$/)
  .describe("Flightdeck app id");
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("YYYY-MM-DD (UTC)");
const version = z
  .string()
  .regex(/^\d{1,5}$/)
  .describe("Workflow version number");

export const PROMPT_ARGS = {
  investigate_bottleneck: z.strictObject({
    app_id: appId,
    workflow_key: slug,
    version: version.optional(),
    from: date.optional(),
    to: date.optional(),
  }),
  explain_dwell_change: z.strictObject({
    app_id: appId,
    workflow_key: slug,
    baseline_from: date,
    baseline_to: date,
    candidate_from: date,
    candidate_to: date,
    stage_key: slug.optional().describe("Focus stage, if any"),
  }),
  compare_process_variants: z.strictObject({
    app_id: appId,
    workflow_key: slug,
    baseline_version: version,
    candidate_version: version,
    from: date.optional(),
    to: date.optional(),
  }),
  evaluate_intervention: z.strictObject({
    app_id: appId,
    workflow_key: slug,
    intervention_date: date.describe("When the change took effect"),
    window_days: z
      .string()
      .regex(/^\d{1,3}$/)
      .optional()
      .describe("Days on each side; default 30"),
  }),
  process_health_review: z.strictObject({
    app_id: appId,
    workflow_key: slug,
    from: date.optional(),
    to: date.optional(),
  }),
};

export type PromptName = keyof typeof PROMPT_ARGS;

const RULES = `Rules for every answer:
- Use only the Flightdeck lifecycle tools' results. Cite each number with its evidence id, sample_n, as_of and watermark.
- Check provenance.synthetic and provenance.freshness first. Label synthetic data as a demo, and stale data as stale.
- Withheld (suppressed) values stay withheld: never estimate, back-calculate or guess them.
- Report observed associations only. Name the confounders and censoring you checked, and state plainly which causal claims the evidence does not support (see unsupported_claims).
- The data has no people. Do not attribute outcomes to individuals or ask for names, notes, scorecards or other personal data.
- You cannot change anything: no tool writes, and you should not suggest that you made a change.

Structure the answer as: Question and scope; Evidence; Data quality and censoring; Confounders considered; What the evidence does not support; Suggested next measurements.`;

const windowArgs = (from?: string, to?: string) =>
  [from ? `"from": "${from}"` : null, to ? `"to": "${to}"` : null].filter(Boolean).join(", ");

const scope = (a: { app_id: string; workflow_key: string }) =>
  `app_id "${a.app_id}", workflow_key "${a.workflow_key}"`;

const DAY = 86_400_000;
const shiftDays = (day: string, days: number) =>
  new Date(Date.parse(day) + days * DAY).toISOString().slice(0, 10);

/** The user-message text of each prompt. */
export const PROMPT_TEXT: {
  [K in PromptName]: (args: z.infer<(typeof PROMPT_ARGS)[K]>) => string;
} = {
  investigate_bottleneck: (a) => `Investigate where cases wait longest in ${scope(a)}.

1. Call build_evidence_pack with question "bottleneck" and baseline {${[a.version ? `"version": ${a.version}` : null, windowArgs(a.from, a.to)].filter(Boolean).join(", ")}}.
2. For the top two ranked stages, call get_stage_dwell with group_by on each declared dimension to see whether the wait is concentrated in one segment.
3. Use get_data_quality to judge censoring: a stage with many open cases may be underestimated, not fast.
4. Treat the ranking as where to look, not a diagnosis. A long stage can be intentional (for example, a soak or a waiting period).

${RULES}`,

  explain_dwell_change: (
    a,
  ) => `Explain the observed change in stage dwell for ${scope(a)} between the baseline window ${a.baseline_from}..${a.baseline_to} and the candidate window ${a.candidate_from}..${a.candidate_to}${a.stage_key ? `, focusing on stage "${a.stage_key}"` : ""}.

1. Call build_evidence_pack with question "dwell_change", baseline {"from": "${a.baseline_from}", "to": "${a.baseline_to}"} and candidate {"from": "${a.candidate_from}", "to": "${a.candidate_to}"}.
2. Read the derived p50/p90 deltas and confirm each against its source evidence ids.
3. Review compare_case_mix in the pack. For every dimension that is not balanced, re-run get_stage_dwell for both windows with that group_by and check whether the change holds within segments.
4. Compare the open-case share of both cohorts (data quality): a more recent window is more right-censored, which shortens its observed dwell.
5. List the alternative explanations: case mix, seasonality, workload, concurrent changes and data completeness.

${RULES}`,

  compare_process_variants: (
    a,
  ) => `Compare workflow versions ${a.baseline_version} (baseline) and ${a.candidate_version} (candidate) of ${scope(a)}.

1. Call build_evidence_pack with question "variants", baseline {"version": ${a.baseline_version}${a.from || a.to ? `, ${windowArgs(a.from, a.to)}` : ""}} and candidate {"version": ${a.candidate_version}}.
2. Read comparison.reasons. If comparable is false, say why and stop at a descriptive summary.
3. Describe the dominant path variants of each version and their shares. Paths pooled as "other" are rare; do not characterise them.
4. Check whether the versions ran over different periods and whether case mix differs, before discussing cycle-time or completion deltas.

${RULES}`,

  evaluate_intervention: (a) => {
    const days = Number(a.window_days ?? "30");
    const before = shiftDays(a.intervention_date, -days);
    const after = shiftDays(a.intervention_date, days);
    return `Evaluate what was observed before and after a process change in ${scope(a)} that took effect on ${a.intervention_date}.

1. Call build_evidence_pack with question "intervention", baseline {"from": "${before}", "to": "${a.intervention_date}"} and candidate {"from": "${a.intervention_date}", "to": "${after}"}.
2. Report the derived dwell and reach deltas with their sample sizes, and treat small or withheld cohorts as inconclusive.
3. This is a before/after comparison with no control group. Check case mix and censoring (the after-cohort has had less time to finish), and consider whether anything else changed in the same period.
4. Say what a stronger design would need: a comparable control segment, a longer follow-up, or a staged rollout.

${RULES}`;
  },

  process_health_review: (
    a,
  ) => `Review the overall health of ${scope(a)}${a.from || a.to ? ` for ${a.from ?? "…"}..${a.to ?? "now"}` : " over the default window"}.

1. Call build_evidence_pack with question "health" and baseline {${windowArgs(a.from, a.to)}}.
2. Summarise freshness and data-quality warnings first; they bound how much the numbers can be trusted.
3. Describe stage dwell, open work, funnel reach and the top bottleneck signals. Compare against the workflow's own history only if you fetch an earlier window, never against invented benchmarks.
4. Flag anything withheld for small cohorts and explain what it means for coverage.

${RULES}`,
};

export const PROMPT_META: Record<PromptName, { title: string; description: string }> = {
  investigate_bottleneck: {
    title: "Investigate a bottleneck",
    description: "Find where cases wait longest and check segments, censoring and alternatives.",
  },
  explain_dwell_change: {
    title: "Explain a dwell change",
    description: "Compare stage dwell between two windows with case-mix and censoring checks.",
  },
  compare_process_variants: {
    title: "Compare process variants",
    description: "Compare path variants and end-to-end metrics of two workflow versions.",
  },
  evaluate_intervention: {
    title: "Evaluate an intervention",
    description: "Before/after evidence around a change date, stating what it cannot show.",
  },
  process_health_review: {
    title: "Process health review",
    description: "Freshness, data quality, dwell, funnel and bottleneck signals of one workflow.",
  },
};

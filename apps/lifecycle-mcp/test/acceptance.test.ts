import { describe, expect, it } from "vitest";
import { LIMITS } from "../src/bounds";
import { investigationOutputs } from "../src/investigation-contract";
import { ANALYSIS_INSTRUCTIONS } from "../src/prompts";
import { ReadApiLifecycleSource } from "../src/sources/read-api";
import {
  DELIVERY_APP,
  RECRUITING_APP,
  SYNTHETIC_ANCHOR,
  syntheticRelations,
} from "../src/sources/synthetic-data";
import {
  cohortCases,
  contentAddress,
  dwellRows,
  expectedDwell,
  goldenSummary,
  HOUR,
  released,
  sample,
} from "./acceptance-oracle";
import golden from "./golden/acceptance-evidence.json";
import {
  call,
  connect,
  ENV,
  NOW,
  RELEASE,
  RESTRICTED,
  raw,
  serviceToken,
  sign,
  synthetic,
} from "./helpers";

/**
 * Black-box acceptance: the official 2026-07-28 MCP client, a locally signed Access JWT and the
 * real Worker handler with the synthetic source injected. No helper is mocked; every expected
 * number is recomputed from the raw fixtures by `acceptance-oracle.ts`. All data is invented.
 */

const K = 5;
const AUG = { from: "2026-08-01T00:00:00.000Z", to: "2026-08-31T00:00:00.000Z" };
const SEP = { from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" };
const TRAILING = { from: "2026-09-30T00:00:00.000Z", to: "2026-10-30T00:00:00.000Z" };

const loopScope = { app_id: RECRUITING_APP, workflow_key: "interview-loop" };
const loopInput = {
  ...loopScope,
  goal: "investigate_bottleneck",
  cohorts: [
    { version: 1, ...AUG },
    { version: 1, ...SEP },
  ],
};
const rolloutScope = { app_id: DELIVERY_APP, workflow_key: "service-rollout" };
const rolloutInput = {
  ...rolloutScope,
  goal: "compare_process_variants",
  cohorts: [
    { version: 1, ...SEP },
    { version: 2, ...SEP },
  ],
};

const LOOP_STAGES = ["defined", "staffing", "scheduling", "conducting", "feedback", "debrief"];

async function collect(args: Record<string, unknown>, setup: Parameters<typeof connect>[0] = {}) {
  const client = await connect(setup);
  const res = await call(client, "collect_investigation_evidence", args);
  await client.close();
  expect(res.isError, res.text).toBe(false);
  return { pack: investigationOutputs.collect_investigation_evidence.parse(res.data), res };
}

describe("scenario 1: interview-loop dwell regression (synthetic recruiting)", () => {
  it("prompt → tools/list → plan → collect finds the feedback (scorecard wait) shift and nothing more", async () => {
    const client = await connect();

    // 1. The analyst's client fetches the prompt: static guidance plus the scope as data.
    const prompt = await client.getPrompt({ name: "investigate_bottleneck", arguments: loopScope });
    expect(prompt.messages[0]?.content).toMatchObject({
      text: expect.stringContaining(ANALYSIS_INSTRUCTIONS),
    });
    expect(prompt.messages[1]?.content).toMatchObject({
      text: JSON.stringify({ untrusted_scope: loopScope }),
    });

    // 2. Discovery: the investigation tools are read-only and no relation/graph tool exists.
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["plan_investigation", "collect_investigation_evidence"]),
    );
    expect(names.some((n) => /relation|child|graph|critical/.test(n))).toBe(false);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    const defs = await call(client, "list_workflow_definitions", { app_id: RECRUITING_APP });
    expect(defs.data.data.definitions.map((d: { workflow_key: string }) => d.workflow_key)).toEqual(
      ["application", "assessment", "headcount-request", "interview-loop", "requisition"],
    );

    // 3. Plan: no data read, explicit refs, graph unsupported.
    const plan = await call(client, "plan_investigation", loopInput);
    expect(plan.isError, plan.text).toBe(false);
    expect(plan.data).toMatchObject({
      data_queries_executed: 0,
      model_invoked: false,
      dependency_graph: "unsupported",
      cohorts: [
        { cohort_ref: "cohort-1", version: 1, ...AUG },
        { cohort_ref: "cohort-2", version: 1, ...SEP },
      ],
    });

    // 4. Collect.
    const res = await call(client, "collect_investigation_evidence", loopInput);
    expect(res.isError, res.text).toBe(false);
    await client.close();
    const pack = investigationOutputs.collect_investigation_evidence.parse(res.data);
    expect(pack).toMatchObject({
      synthetic: true,
      model_invoked: false,
      causal: false,
      as_of: new Date(NOW).toISOString(),
      watermark: new Date(SYNTHETIC_ANCHOR).toISOString(),
      checks: {
        status: "bounded_evidence",
        snapshot_consistent: true,
        fresh: true,
        window_covered: true,
        min_cohort: K,
        matched_cohorts: "not_verified",
        censoring: "completed_intervals_only_open_cases_right_censored",
        outcome_detail: "completion_only_no_outcome_breakdown",
      },
    });

    // Samples and every released dwell cell match the independent oracle.
    const aug = cohortCases(RECRUITING_APP, "interview-loop", 1, AUG.from, AUG.to);
    const sep = cohortCases(RECRUITING_APP, "interview-loop", 1, SEP.from, SEP.to);
    expect(pack.checks.samples).toEqual([
      { cohort_ref: "cohort-1", ...sample(aug) },
      { cohort_ref: "cohort-2", ...sample(sep) },
    ]);
    // Hand-checked against the probe of the raw fixtures (see the acceptance doc).
    expect(sample(aug)).toEqual({ n: 58, completed_n: 58, open_n: 0 });
    expect(sample(sep)).toEqual({ n: 50, completed_n: 50, open_n: 0 });
    for (const [ref, cases] of [
      ["cohort-1", aug],
      ["cohort-2", sep],
    ] as const) {
      const rows = dwellRows(pack, ref);
      for (const stage of LOOP_STAGES) {
        expect(rows[stage], `${ref}/${stage}`).toMatchObject(
          released(expectedDwell(cases, stage), K),
        );
      }
    }

    // The finding: feedback p50 rose about fivefold; scheduling did not rise.
    const before = dwellRows(pack, "cohort-1");
    const after = dwellRows(pack, "cohort-2");
    const p50 = (row: (typeof before)[string] | undefined) =>
      row && !row.suppressed ? (row.p50_ms ?? Number.NaN) : Number.NaN;
    const deltas = LOOP_STAGES.map((s) => [s, p50(after[s]) - p50(before[s])] as const).sort(
      (a, b) => b[1] - a[1],
    );
    expect(deltas[0]?.[0]).toBe("feedback");
    expect(Math.round(p50(before.feedback) / HOUR)).toBe(12);
    expect(Math.round(p50(after.feedback) / HOUR)).toBe(66);
    expect(p50(after.scheduling)).toBeLessThan(p50(before.scheduling));
    // on_hold has fewer than k completed loops in cohort 2: withheld, never shown as a value.
    expect(after.on_hold).toMatchObject({ suppressed: true, reason: "small_cohort" });
    expect(pack.checks.any_suppressed).toBe(true);

    // No causal or hiring-decision content; no case ids or per-case outcomes.
    const body = JSON.stringify(pack);
    expect(pack.warnings[0]).toContain("no causal conclusions");
    expect(pack.warnings.join(" ")).toContain("SYNTHETIC DATA");
    expect(body).not.toMatch(/c_rc_|"case_id"|"outcome"|"advance"|"reject"/);

    // Content-addressed and stable: recomputed hash, qualified refs, golden fixture.
    expect(await contentAddress(pack)).toBe(pack.evidence_id);
    expect(pack.evidence_ref).toBe(`urn:flightdeck:evidence:${pack.evidence_id}`);
    for (const e of pack.entries) {
      expect(e.ref.startsWith(`${pack.evidence_ref}#entry-`)).toBe(true);
      for (const s of e.source_refs) expect(pack.source_reads.map((r) => r.ref)).toContain(s);
    }
    expect(goldenSummary(pack)).toEqual(golden.interview_loop_regression);
    expect(res.text.length).toBeLessThan(500);
    expect(JSON.stringify(res.data).length).toBeLessThan(LIMITS.maxResultChars);
  });

  it("keeps loop-level aggregates but refuses child dependencies the source cannot see", async () => {
    // The fixtures do hold explicit loop -> 3 assessment-track links...
    const loops = cohortCases(RECRUITING_APP, "interview-loop", 1, SEP.from, SEP.to);
    const relations = syntheticRelations();
    const tracksOf = (id: string) => relations.filter((r) => r.parent_case_id === id);
    const staffed = loops.filter((c) => c.intervals.some((i) => i.stage_key === "scheduling"));
    expect(staffed.length).toBeGreaterThan(40);
    for (const c of staffed) expect(tracksOf(c.case_id)).toHaveLength(3);

    // ...but MCP exposes none of them, so child questions are an explicit insufficiency.
    const client = await connect();
    for (const name of ["plan_investigation", "collect_investigation_evidence"]) {
      const res = await call(client, name, {
        ...loopInput,
        dependency_scope: "child_dependencies",
      });
      expect(res.error?.code).toBe("insufficient_evidence");
      expect(res.text).toContain("critical paths");
    }
    // Nested graph shapes are not accepted as inputs at all.
    for (const extra of [
      { include_children: true },
      { relations: [{ parent: "x", child: "y" }] },
      { dependency_scope: "critical_path" },
    ]) {
      expect((await call(client, "plan_investigation", { ...loopInput, ...extra })).isError).toBe(
        true,
      );
    }
    // The assessment tracks remain analysable as their own population, unlinked to loops.
    const tracks = await call(client, "get_stage_dwell", {
      app_id: RECRUITING_APP,
      workflow_key: "assessment",
      ...SEP,
      group_by: "track",
    });
    expect(tracks.isError, tracks.text).toBe(false);
    const groups = new Set(tracks.data.data.stages.map((r: { group: string }) => r.group));
    expect(groups).toEqual(new Set(["skills", "collaboration", "domain"]));
    await client.close();
  });

  it("right-censors the trailing 30-day window at a fixed as_of and flags stale data", async () => {
    const trailing = cohortCases(RECRUITING_APP, "interview-loop", 1, TRAILING.from, TRAILING.to);
    const expected = sample(trailing);
    expect(expected.open_n).toBeGreaterThanOrEqual(K);
    const { pack } = await collect({
      ...loopScope,
      goal: "process_health_review",
      cohorts: [{ version: 1, ...TRAILING }],
    });
    expect(pack.checks.samples).toEqual([{ cohort_ref: "cohort-1", ...expected }]);
    expect(pack.checks.window_covered).toBe(true);
    const rows = dwellRows(pack, "cohort-1");
    for (const stage of LOOP_STAGES) {
      expect(rows[stage]).toMatchObject(released(expectedDwell(trailing, stage), K));
    }

    // Two hours later with no new events the same pack is stale and insufficient.
    const later = NOW + 2 * HOUR;
    const stale = await collect(
      { ...loopScope, goal: "process_health_review", cohorts: [{ version: 1, ...AUG }] },
      { now: () => later, source: synthetic({ now: () => later }) },
    );
    expect(stale.pack.freshness.data.status).toBe("stale");
    expect(stale.pack.checks).toMatchObject({ fresh: false, status: "insufficient_evidence" });
    expect(stale.pack.warnings.join(" ")).toContain("Stale or unavailable watermarks");
  });
});

describe("scenario 2: service rollout v1 vs v2 (synthetic delivery)", () => {
  it("compares versions in a common window with comparability flags and no causal claim", async () => {
    const client = await connect();
    const prompt = await client.getPrompt({
      name: "compare_process_variants",
      arguments: rolloutScope,
    });
    expect(prompt.messages).toHaveLength(2);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain(
      "collect_investigation_evidence",
    );
    const plan = await call(client, "plan_investigation", rolloutInput);
    expect(plan.isError, plan.text).toBe(false);
    const res = await call(client, "collect_investigation_evidence", rolloutInput);
    expect(res.isError, res.text).toBe(false);
    const pack = investigationOutputs.collect_investigation_evidence.parse(res.data);

    const v1 = cohortCases(DELIVERY_APP, "service-rollout", 1, SEP.from, SEP.to);
    const v2 = cohortCases(DELIVERY_APP, "service-rollout", 2, SEP.from, SEP.to);
    expect(sample(v1)).toEqual({ n: 51, completed_n: 51, open_n: 0 });
    expect(sample(v2)).toEqual({ n: 46, completed_n: 46, open_n: 0 });
    expect(pack.checks).toMatchObject({
      status: "bounded_evidence",
      samples: [
        { cohort_ref: "cohort-1", ...sample(v1) },
        { cohort_ref: "cohort-2", ...sample(v2) },
      ],
    });
    // Rollbacks are closed cases: completion here is "ended", not "succeeded".
    expect(v1.filter((c) => c.outcome === "rolled_back")).toHaveLength(9);
    expect(v2.filter((c) => c.outcome === "rolled_back")).toHaveLength(3);
    expect(pack.checks.outcome_detail).toBe("completion_only_no_outcome_breakdown");

    // Stage sets differ: bake exists only in v2; pauses are withheld below k.
    const r1 = dwellRows(pack, "cohort-1");
    const r2 = dwellRows(pack, "cohort-2");
    expect(r1.bake).toBeUndefined();
    expect(r2.bake).toMatchObject(released(expectedDwell(v2, "bake"), K));
    for (const [rows, cases] of [
      [r1, v1],
      [r2, v2],
    ] as const) {
      for (const stage of ["planned", "build", "verify", "rolling_out", "paused"]) {
        expect(rows[stage], stage).toMatchObject(released(expectedDwell(cases, stage), K));
      }
    }
    // Retries (repeat build/verify, paused-then-resumed rollout) appear as repeated path keys.
    const paths = v1.map((c) => c.intervals.map((i) => i.stage_key));
    expect(paths.some((p) => p.filter((s) => s === "rolling_out").length === 2)).toBe(true);
    expect(paths.some((p) => p.filter((s) => s === "verify").length === 2)).toBe(true);

    // Direct end-to-end comparison: flagged as different stage sets and non-causal.
    const cmp = await call(client, "compare_workflow_variants", {
      ...rolloutScope,
      baseline_version: 1,
      candidate_version: 2,
      ...SEP,
    });
    expect(cmp.isError, cmp.text).toBe(false);
    expect(cmp.data.interpretation.causal).toBe(false);
    expect(cmp.data.data.comparison.reasons).toEqual([
      "Each version's cases differ in timing and case mix; differences are not caused by the version alone.",
      "The versions define different stages; compare end-to-end metrics only.",
    ]);

    // Region-level failures exist as their own population; tying them to parents does not.
    const regions = await call(client, "get_funnel", {
      app_id: DELIVERY_APP,
      workflow_key: "regional-deployment",
      ...SEP,
      group_by: "region",
    });
    expect(regions.isError, regions.text).toBe(false);
    const ask = await call(client, "collect_investigation_evidence", {
      ...rolloutInput,
      dependency_scope: "child_dependencies",
    });
    expect(ask.error?.code).toBe("insufficient_evidence");
    await client.close();

    expect(await contentAddress(pack)).toBe(pack.evidence_id);
    expect(goldenSummary(pack)).toEqual(golden.service_rollout_variants);
    expect(JSON.stringify(res.data).length).toBeLessThan(LIMITS.maxResultChars);
  });
});

describe("acceptance: access, input and integrity failures", () => {
  it("401 without or with a foreign Access token, 403 for a foreign Origin", async () => {
    expect((await raw("tools/list", {}, { token: null })).status).toBe(401);
    const foreign = await sign({ email: "analyst@example.com" }, { aud: "dashboard-aud" });
    expect((await raw("tools/list", {}, { token: foreign })).status).toBe(401);
    const origin = await raw("tools/list", {}, { headers: { Origin: "https://evil.example" } });
    expect(origin.status).toBe(403);
  });

  it("enforces role grants, the service-token cap and cross-app denial", async () => {
    const reader = await connect({
      source: synthetic({
        grants: () => [{ appId: RECRUITING_APP, role: "reader", expiresAt: null }],
      }),
    });
    expect((await call(reader, "get_data_freshness", { app_id: RECRUITING_APP })).isError).toBe(
      false,
    );
    expect((await call(reader, "plan_investigation", loopInput)).error?.code).toBe("forbidden");
    await reader.close();

    const service = await connect({
      token: await serviceToken(),
      source: synthetic({
        grants: () => [{ appId: RECRUITING_APP, role: "admin", expiresAt: null }],
      }),
    });
    expect((await call(service, "collect_investigation_evidence", loopInput)).error?.code).toBe(
      "forbidden",
    );
    await service.close();

    const recruitingOnly = await connect({
      source: synthetic({
        grants: () => [{ appId: RECRUITING_APP, role: "analyst", expiresAt: null }],
      }),
    });
    expect((await call(recruitingOnly, "plan_investigation", loopInput)).isError).toBe(false);
    for (const app_id of [DELIVERY_APP, RESTRICTED, RELEASE]) {
      expect(
        (await call(recruitingOnly, "collect_investigation_evidence", { ...rolloutInput, app_id }))
          .error?.code,
      ).toBe("forbidden");
    }
    await recruitingOnly.close();
  });

  it("withholds tiny cohorts and rare groups instead of reporting them", async () => {
    const { pack } = await collect({
      ...loopScope,
      goal: "process_health_review",
      cohorts: [{ version: 1, from: "2026-08-01T00:00:00.000Z", to: "2026-08-03T00:00:00.000Z" }],
    });
    expect(pack.checks.samples[0]).toMatchObject({ n: null, completed_n: null });
    expect(pack.checks.status).toBe("insufficient_evidence");

    const client = await connect();
    const byFormat = await call(client, "get_stage_dwell", {
      ...loopScope,
      from: "2026-07-01",
      to: "2026-10-29",
      group_by: "loop_format",
    });
    const feedback = byFormat.data.data.stages.filter(
      (r: { stage_key: string }) => r.stage_key === "feedback",
    );
    expect(feedback.find((r: { group: string }) => r.group === "hybrid")).toMatchObject({
      suppressed: true,
      reason: "small_cohort",
    });
    // Complementary suppression stops recovering hybrid by subtraction from the total.
    expect(feedback.some((r: { reason?: string }) => r.reason === "complementary")).toBe(true);
    await client.close();
  });

  it("rejects malformed dates, future windows and mismatched temporal cohorts", async () => {
    const client = await connect();
    for (const cohort of [
      { from: "2026-02-30T00:00:00Z", to: "2026-03-30T00:00:00Z" },
      { from: "2026-09-01", to: "2026-10-01" },
      { from: "2026-09-01T00:00:00", to: "2026-10-01T00:00:00" },
      { from: "yesterday", to: SEP.to },
      { from: SEP.to, to: SEP.from },
      { from: "2026-11-15T00:00:00Z", to: "2026-12-15T00:00:00Z" },
    ]) {
      const res = await call(client, "plan_investigation", {
        ...loopInput,
        cohorts: [
          { version: 1, ...AUG },
          { version: 1, ...cohort },
        ],
      });
      expect(res.isError, JSON.stringify(cohort)).toBe(true);
    }
    await client.close();
  });

  it("detects evidence tampering and never accepts evidence ids as input", async () => {
    const { pack } = await collect(loopInput);
    const tampered = structuredClone(pack);
    const sample0 = tampered.checks.samples[0];
    if (sample0) sample0.n = (sample0.n ?? 0) + 1;
    expect(await contentAddress(tampered)).not.toBe(pack.evidence_id);
    const relabelled = { ...structuredClone(pack), evidence_id: `sha256:${"0".repeat(64)}` };
    expect(await contentAddress(relabelled)).toBe(pack.evidence_id);
    expect(relabelled.evidence_id).not.toBe(pack.evidence_id);

    const client = await connect();
    for (const extra of [
      { evidence_id: pack.evidence_id },
      { evidence_ref: pack.evidence_ref },
      { evidence: pack.entries },
    ]) {
      expect(
        (await call(client, "collect_investigation_evidence", { ...loopInput, ...extra })).isError,
      ).toBe(true);
    }
    expect(
      (
        await call(client, "get_case_summary", {
          app_id: RECRUITING_APP,
          case_id: pack.evidence_ref,
        })
      ).isError,
    ).toBe(true);
    await client.close();
  });

  it("keeps the real read API fail closed for the acceptance apps", async () => {
    const client = await connect({
      env: { ...ENV, LIFECYCLE_MCP_SOURCE: "read-api" },
      source: new ReadApiLifecycleSource(undefined),
    });
    expect((await call(client, "collect_investigation_evidence", loopInput)).error?.code).toBe(
      "source_unavailable",
    );
    await client.close();
  });
});

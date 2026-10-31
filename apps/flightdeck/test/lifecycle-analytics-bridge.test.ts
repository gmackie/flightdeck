import { env } from "cloudflare:workers";
import type { Query } from "@flightdeckhq/lifecycle-queries";
import { beforeAll, describe, expect, it } from "vitest";
import { generate } from "../../../examples/lifecycle-fixtures/lib/generate.mjs";
import { type BridgeScope, materializedAdapter } from "../src/lifecycle-analytics/bridge";
import { outcomeSummary } from "../src/lifecycle-serving/read";
import { adaptFixtures } from "./support/fixture-adapter";
import { attempts, deliver, type Json, producerApp, project, servedModel } from "./support/harness";

/**
 * Workstream G's query contracts answered from the materialized D1 read model, cross-checked
 * against the read model's own SQL aggregates and an independent computation from served rows.
 * The Basin SQL executor is NOT exercised here: that needs a real Basin credential (separate gate).
 */

const APP = "app_bridge_platform";
const PROCESS = "service_delivery.deployment";
const FROM = "2026-01-05T00:00:00.000Z";
const TO = "2026-05-05T00:00:00.000Z";
const POLICY = { availableFrom: FROM, maxWindowDays: 366, minSampleSize: 2 };
const OUTCOMES = {
  succeeded: "completed",
  failed: "failed",
  rolled_back: "failed",
  cancelled: "cancelled",
} as const;
const scope = (outcomes: BridgeScope["outcomes"] = OUTCOMES): BridgeScope => ({
  appId: APP,
  processKey: PROCESS,
  versions: [1],
  cohortId: "all",
  caseMix: "all",
  outcomes,
});

beforeAll(async () => {
  const { records } = generate({ seed: "7", events: 1000 });
  const { byApp } = await adaptFixtures(records);
  await deliver(await producerApp(APP), byApp.get("app_platform") ?? []);
  await project(APP);
});

function query(metric: Query["metric"], asOf: string): Query {
  return {
    appId: APP,
    definitionId: PROCESS,
    definitionVersions: ["v1"],
    metricVersion: "lifecycle.v1",
    from: FROM,
    to: TO,
    asOf,
    cohort: { id: "all", caseMix: ["all"] },
    metric,
    groupBy: [],
    filters: [],
    topN: 20,
  };
}

describe("G queries over the materialized read model", () => {
  it("outcome counts agree with the read model's own outcome summary", async () => {
    // Unsuppressed on both sides: G groups by mapped class, the read model by domain outcome, so
    // their minimum-cohort suppression legitimately withholds different groups.
    const { adapter, watermark } = await materializedAdapter(env.DB, scope(), {
      ...POLICY,
      minSampleSize: 2,
    });
    const result = await adapter.query(query({ kind: "outcomes" }, watermark));
    const served = await outcomeSummary(
      env.DB,
      APP,
      {
        processKey: PROCESS,
        version: 1,
        status: null,
        startedAfter: Date.parse(FROM),
        startedBefore: Date.parse(TO),
      },
      1,
    );
    const expected: Record<string, number> = {};
    for (const g of served.groups) {
      const key = g.status === "open" ? "open" : OUTCOMES[g.outcome as keyof typeof OUTCOMES];
      expected[key] = (expected[key] ?? 0) + g.case_count;
    }
    const raw = Object.fromEntries(result.rows.map((r) => [r.key, r.count]));
    // G releases a count only at or above its minimum; compare those it released.
    const got = Object.fromEntries(Object.entries(raw).filter(([, n]) => n !== null));
    for (const [key, n] of Object.entries(expected)) if (n < 2) delete expected[key];
    expect(Object.keys(expected).length).toBeGreaterThan(1);
    expect(got).toEqual(expected);
    expect(result.metadata).toMatchObject({
      watermark,
      approximation: "exact-nearest-rank-fixture",
    });
  });

  it("per-case stage dwell matches an independent computation from served intervals", async () => {
    const { adapter, watermark, stages } = await materializedAdapter(env.DB, scope(), POLICY);
    const model = await servedModel(APP);
    const byCase = attempts(model.intervals);
    const inWindow = model.cases.filter(
      (c: Json) =>
        c.process_key === PROCESS &&
        c.started_at >= Date.parse(FROM) &&
        c.started_at < Date.parse(TO),
    );
    // The busiest stage gives the largest sample.
    const stage = stages
      .map((s) => ({
        s,
        n: inWindow.filter((c: Json) => byCase.get(c.case_id)?.some((a) => a.stage === s)).length,
      }))
      .sort((a, b) => b.n - a.n)[0]?.s as string;
    const observed: number[] = [];
    let censored = 0;
    for (const c of inWindow as Json[]) {
      const visits = (byCase.get(c.case_id) ?? []).filter((a) => a.stage === stage);
      if (!visits.length) continue;
      if (visits.some((a) => a.exited === null)) censored++;
      else observed.push(visits.reduce((n, a) => n + ((a.exited as number) - a.entered), 0));
    }
    observed.sort((a, b) => a - b);
    const nearest = (p: number) => observed[Math.ceil(observed.length * p) - 1] ?? null;
    const result = await adapter.query(query({ kind: "stage-dwell", stageId: stage }, watermark));
    expect(observed.length).toBeGreaterThanOrEqual(POLICY.minSampleSize);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      key: stage,
      observedCases: observed.length,
      p50Ms: nearest(0.5),
      p90Ms: nearest(0.9),
    });
    if (censored >= POLICY.minSampleSize) expect(result.rows[0]?.censoredCases).toBe(censored);
  });

  it("excludes and counts outcomes without an explicit mapping instead of guessing", async () => {
    const { rolled_back: _, ...partial } = OUTCOMES;
    const full = await materializedAdapter(env.DB, scope(), POLICY);
    const without = await materializedAdapter(env.DB, scope(partial), POLICY);
    const rolledBack = (await servedModel(APP)).cases.filter(
      (c: Json) => c.process_key === PROCESS && c.outcome === "rolled_back",
    ).length;
    expect(rolledBack).toBeGreaterThan(0);
    expect(without.unmapped).toEqual({ rolled_back: rolledBack });
    const caseFacts = (m: typeof full) => m.facts.filter((f) => f.kind === "case").length;
    expect(caseFacts(full) - caseFacts(without)).toBe(rolledBack);
  });

  it("keeps G's own validation: unregistered versions and cross-app queries are refused", async () => {
    const { adapter, watermark } = await materializedAdapter(env.DB, scope(), POLICY);
    await expect(
      adapter.query({ ...query({ kind: "outcomes" }, watermark), definitionVersions: ["v9"] }),
    ).rejects.toThrow(/Unregistered definition version/);
    await expect(
      adapter.query({ ...query({ kind: "outcomes" }, watermark), appId: "app_someone_else" }),
    ).rejects.toThrow(/scope does not match/);
  });
});

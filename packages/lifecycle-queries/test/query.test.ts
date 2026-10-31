import { describe, expect, it, vi } from "vitest";
import {
  type AggregateRow,
  buildBasinSql,
  createBasinAdapter,
  createFakeAdapter,
  demoQuery,
  demoRegistry,
  demoWatermark,
  type LifecycleFact,
  type Metric,
  type Query,
  type QueryRegistry,
  syntheticFacts,
  validateQuery,
} from "../src/index.js";
import { sqlFixture } from "./sql-fixture.js";

const query = <M extends Metric = typeof demoQuery.metric>(
  metric: M = demoQuery.metric as M,
  overrides: Partial<Query<M>> = {},
): Query<M> => ({
  ...structuredClone(demoQuery),
  metric,
  ...overrides,
});
const fake = (facts = syntheticFacts(), registry = demoRegistry, watermark = demoWatermark) =>
  createFakeAdapter(facts, registry, watermark);
const raw: AggregateRow = {
  key: "review",
  group: {},
  arm: "primary",
  sampleSize: 3,
  observedCases: 3,
  censoredCases: 0,
  count: 3,
  p50Ms: 10,
  p75Ms: 20,
  p90Ms: 30,
};
const evidence = { watermark: demoWatermark, eligibleCases: 12, coveredCases: 12 };
function mutateRegistry(change: (registry: QueryRegistry) => void) {
  const value = structuredClone(demoRegistry);
  change(value);
  return value;
}
function caseFacts(id: string, options: Partial<LifecycleFact> = {}): LifecycleFact[] {
  return syntheticFacts()
    .filter((fact) => fact.caseId === "after-routine-1")
    .map(
      (fact) =>
        ({ ...fact, caseId: id, factId: `${id}-${fact.kind}`, ...options }) as LifecycleFact,
    );
}
// Keep checkpoint identities distinct (caseFacts is only used in case/interval tests).
function simple(id: string, options: Partial<LifecycleFact> = {}) {
  return caseFacts(id, options).filter((fact) => fact.kind !== "checkpoint");
}

describe("runtime query boundary", () => {
  it("accepts all supported metrics with explicit bounded scope", () => {
    for (const metric of [
      { kind: "case-counts" },
      { kind: "current-open-age" },
      { kind: "outcomes" },
      { kind: "variant-counts" },
      { kind: "funnel", checkpoints: ["start", "finish"] },
      { kind: "comparison", stageId: "review", reference: { id: "before", caseMix: ["routine"] } },
    ] as Metric[])
      expect(() => validateQuery(query(metric), demoRegistry)).not.toThrow();
  });
  it.each([
    { appId: "other" },
    { definitionId: "other" },
    { metricVersion: "v0" },
    { from: null },
    { to: null },
    { asOf: null },
    { from: "2026-02-30T00:00:00.000Z" },
    { from: "2026-01-01T00:00:00+00:00" },
    { from: "2026-01-01" },
    { to: demoQuery.from },
    { to: "2026-01-14T00:00:00.000Z" },
    { from: "2025-12-31T00:00:00.000Z" },
    { to: "2026-03-01T00:00:00.000Z", asOf: "2026-03-02T00:00:00.000Z" },
    { definitionVersions: [] },
    { definitionVersions: ["v1", "v1"] },
    { definitionVersions: ["v0"] },
    { groupBy: ["caseMix", "caseMix"] },
    { groupBy: ["caseMix", "cohortId", "outcome"] },
    { topN: 0 },
    { topN: 101 },
    { topN: 1.5 },
    { topN: NaN },
    { cohort: null },
    { cohort: { id: "after", caseMix: [] } },
    { cohort: { id: "after", caseMix: ["unknown"] } },
    { filters: [{ field: "outcome", values: [] }] },
    { filters: [{ field: "outcome", values: ["open", "open"] }] },
    { filters: [{ field: "outcome", values: ["unknown"] }] },
    {
      filters: [
        { field: "outcome", values: ["open"] },
        { field: "outcome", values: ["failed"] },
      ],
    },
    { metric: { kind: "raw-sql" } },
    { metric: { kind: "stage-dwell", stageId: "unknown" } },
    { metric: { kind: "funnel", checkpoints: [] } },
    { metric: { kind: "funnel", checkpoints: ["start", "start"] } },
    { metric: { kind: "funnel", checkpoints: ["unknown"] } },
  ])("rejects invalid request %j", (patch) =>
    expect(() => buildBasinSql({ ...query(), ...patch } as Query, demoRegistry)).toThrow(),
  );
  it.each([
    "' OR 1=1 --",
    "x'; DROP TABLE lifecycle_facts; --",
    'x"; UPDATE cases SET a=1',
    "x\\'",
    "x\u0000",
    "x\nUNION SELECT 1",
    "x/*a*/",
    "x;INSERT INTO a VALUES(1)",
  ])("rejects SQL payload in every interpolation: %s", (payload) => {
    const patches = [
      { appId: payload },
      { definitionId: payload },
      { definitionVersions: [payload] },
      { groupBy: [payload] },
      { cohort: { id: payload, caseMix: ["routine"] } },
      { cohort: { id: "after", caseMix: [payload] } },
      { filters: [{ field: payload, values: ["open"] }] },
      { filters: [{ field: "outcome", values: [payload] }] },
      { metric: { kind: "stage-dwell", stageId: payload } },
      { metric: { kind: "funnel", checkpoints: [payload] } },
      { topN: payload },
      { asOf: payload },
    ];
    for (const patch of patches)
      expect(() => buildBasinSql({ ...query(), ...patch } as Query, demoRegistry)).toThrow();
    expect(() => buildBasinSql(query(), demoRegistry, payload)).toThrow();
    expect(() =>
      buildBasinSql(
        query(),
        mutateRegistry((registry) => {
          registry.versions = {
            [payload]: registry.versions.v1 as NonNullable<typeof registry.versions.v1>,
          };
        }),
      ),
    ).toThrow();
  });
  it("rejects unsafe registry mappings, policy, and ambiguous canonical mappings", () => {
    for (const change of [
      (r: QueryRegistry) => {
        r.minSampleSize = 1;
      },
      (r: QueryRegistry) => {
        r.maxWindowDays = 400;
      },
      (r: QueryRegistry) => {
        r.versions = {};
      },
      (r: QueryRegistry) => {
        r.versions = {
          v1: {
            ...(r.versions.v1 as NonNullable<typeof r.versions.v1>),
            stages: { old: "review", new: "review" },
          },
        };
      },
      (r: QueryRegistry) => {
        r.versions = {
          v1: {
            ...(r.versions.v1 as NonNullable<typeof r.versions.v1>),
            stages: { review: "x';SELECT 1" },
          },
        };
      },
    ])
      expect(() => buildBasinSql(query(), mutateRegistry(change))).toThrow();
  });
  it("rejects non-comparable versions and comparisons that remove an arm", () => {
    expect(() =>
      buildBasinSql(query(undefined, { definitionVersions: ["v1", "v3"] }), demoRegistry),
    ).toThrow(/Non-comparable/);
    const metric = {
      kind: "comparison",
      stageId: "review",
      reference: { id: "before", caseMix: ["routine"] },
    } as const;
    expect(() =>
      buildBasinSql(query({ ...metric, reference: demoQuery.cohort }), demoRegistry),
    ).toThrow(/distinct/);
    expect(() => buildBasinSql(query(metric, { groupBy: ["cohortId"] }), demoRegistry)).toThrow(
      /group/,
    );
    expect(() =>
      buildBasinSql(
        query(metric, { filters: [{ field: "cohortId", values: ["after"] }] }),
        demoRegistry,
      ),
    ).toThrow(/filter/);
  });
});

describe("metric semantics and fixtures", () => {
  it("computes case weighted dwell percentiles excluding right censored cases", async () => {
    const result = await fake().query(demoQuery);
    expect(result.rows).toHaveLength(2);
    expect(result.rows.find((row) => row.group.caseMix === "routine")).toMatchObject({
      sampleSize: 6,
      p50Ms: 3 * 3600000,
      p75Ms: 4 * 3600000,
      p90Ms: 5 * 3600000,
      observedCases: null,
      censoredCases: null,
    });
    expect(result.metadata).toMatchObject({
      sampleSize: 12,
      approximation: "exact-nearest-rank-fixture",
      asOf: demoWatermark,
      coverage: { ratio: 1 },
      suppression: { minSampleSize: 3 },
    });
  });
  it("counts each case once and sums repeat visits before percentiles", async () => {
    const cases = ["a", "b", "c"].flatMap((id) => simple(id));
    const repeats = cases
      .filter((fact) => fact.kind === "interval")
      .map((fact) => ({ ...fact, factId: `${fact.factId}-repeat` }));
    const result = await fake([...cases, ...repeats]).query(query(undefined, { groupBy: [] }));
    expect(result.rows[0]).toMatchObject({ sampleSize: 3, count: 3, p50Ms: 7200000 });
  });
  it("open age uses asOf and excludes completed outcomes", async () => {
    const facts = ["a", "b", "c"].flatMap((id) =>
      simple(id, { outcome: "open", caseEndedAt: null }),
    );
    const result = await fake([...facts, ...simple("closed")]).query(
      query({ kind: "current-open-age" }, { groupBy: [] }),
    );
    expect(result.rows[0]).toMatchObject({
      count: 3,
      observedCases: 0,
      censoredCases: 3,
      p50Ms: 10 * 86400000,
    });
  });
  it("keeps completed, cancelled, failed, and open outcomes separate", async () => {
    const facts = (["completed", "cancelled", "failed", "open"] as const).flatMap((outcome) =>
      [1, 2, 3].flatMap((n) =>
        simple(`${outcome}-${n}`, {
          outcome,
          caseEndedAt: outcome === "open" ? null : "2026-01-02T01:00:00.000Z",
        }),
      ),
    );
    const result = await fake(facts).query(query({ kind: "outcomes" }, { groupBy: [] }));
    expect(result.rows.map((row) => [row.key, row.count])).toEqual([
      ["cancelled", 3],
      ["completed", 3],
      ["failed", 3],
      ["open", 3],
    ]);
  });
  it("maps source variants and filters only registered canonical values", async () => {
    const result = await fake().query(
      query(
        { kind: "variant-counts" },
        {
          groupBy: [],
          filters: [
            { field: "variantId", values: ["standard"] },
            { field: "caseMix", values: ["routine"] },
          ],
        },
      ),
    );
    expect(result.rows[0]).toMatchObject({ key: "standard", count: 6 });
    expect(result.metadata.sampleSize).toBe(6);
  });
  it("requires ordered checkpoints with prior membership", async () => {
    const facts = syntheticFacts();
    for (const fact of facts)
      if (
        fact.caseId === "after-routine-1" &&
        fact.kind === "checkpoint" &&
        fact.checkpointId === "done"
      )
        fact.sequence = 0;
    const result = await fake(facts).query(
      query({ kind: "funnel", checkpoints: ["start", "finish"] }, { groupBy: [] }),
    );
    expect(result.rows.map((row) => [row.key, row.count])).toEqual([
      ["start", 12],
      ["finish", 9],
    ]);
  });
  it("rejects reusing checkpoint IDs within a revision", () => {
    const facts = syntheticFacts();
    const checkpoint = facts.find((fact) => fact.kind === "checkpoint");
    expect(() => fake([...facts, { ...checkpoint, factId: "new" } as LifecycleFact])).toThrow(
      /Duplicate checkpoint/,
    );
  });
  it("comparisons stay stratified and use semantic version mappings", async () => {
    const result = await fake().query({
      ...demoQuery,
      metric: {
        kind: "comparison",
        stageId: "review",
        reference: { id: "before", caseMix: ["routine", "urgent"] },
      },
      groupBy: [],
    });
    expect(result.rows).toHaveLength(2);
    expect(result.rows.every((row) => row.comparable && row.deltaP50Ms === -2 * 3600000)).toBe(
      true,
    );
    expect(result.rows.map((row) => row.group.caseMix).sort()).toEqual(["routine", "urgent"]);
  });
  it("does not compare a missing stratum or small observed sample", async () => {
    const metric = {
      kind: "comparison",
      stageId: "review",
      reference: { id: "before", caseMix: ["routine"] },
    } as const;
    const result = await fake(
      syntheticFacts().filter(
        (fact) =>
          fact.caseId !== "before-routine-4" &&
          fact.caseId !== "before-routine-5" &&
          fact.caseId !== "before-routine-3",
      ),
    ).query({ ...demoQuery, metric, groupBy: [] });
    expect(result.rows.some((row) => row.reason === "missing-stratum")).toBe(true);
    expect(result.rows.some((row) => row.reason === "suppressed")).toBe(true);
    expect(result.rows.every((row) => !row.comparable && row.deltaP50Ms === null)).toBe(true);
  });
  it("uses stable topN with explicit truncation and no invented zero rows", async () => {
    const result = await fake().query(query(undefined, { topN: 1 }));
    expect(result.rows).toHaveLength(1);
    expect(result.metadata.truncated).toBe(true);
    const empty = await fake([]).query(query());
    expect(empty.rows).toEqual([]);
    expect(empty.metadata.coverage.ratio).toBeNull();
    expect(empty.metadata.sampleSize).toBe(0);
  });
});

describe("data quality, revisions, and suppression", () => {
  it("deduplicates identical replays by scoped revision/fact identity", async () => {
    const facts = syntheticFacts();
    expect(await fake([...facts, ...facts]).query(demoQuery)).toEqual(
      await fake(facts).query(demoQuery),
    );
    const foreign = facts.map((fact) => ({ ...fact, appId: "other" }));
    expect(await fake([...facts, ...foreign]).query(demoQuery)).toEqual(
      await fake(facts).query(demoQuery),
    );
  });
  it("rejects conflicting replay, partial snapshots, and inconsistent attributes", () => {
    const facts = simple("a"),
      base = facts[0] as LifecycleFact;
    expect(() => fake([...facts, { ...base, outcome: "failed" }])).toThrow(/Conflicting/);
    expect(() => fake(facts.filter((fact) => fact.kind !== "case"))).toThrow(/exactly one/);
    expect(() => fake([...facts, { ...base, factId: "second-case" }])).toThrow(/exactly one/);
    expect(() =>
      fake(
        facts.map((fact) => (fact.kind === "interval" ? { ...fact, cohortId: "before" } : fact)),
      ),
    ).toThrow(/Inconsistent/);
    expect(() =>
      fake([...facts, ...simple("a", { revision: 2, caseStartedAt: "2026-01-03T00:00:00.000Z" })]),
    ).toThrow(/immutable/);
  });
  it.each([
    { revision: 0 },
    { recordedAt: "bad" },
    { recordedAt: "2026-01-13T00:00:00.000Z" },
    { factId: "" },
    { caseStartedAt: "bad" },
    { outcome: "unknown" },
    { kind: "unknown" },
    { enteredAt: "bad" },
  ])("rejects malformed fixture facts %j", (patch) =>
    expect(() => fake(simple("a", patch as Partial<LifecycleFact>))).toThrow(),
  );
  it("does not invent null start or completion times and reports case coverage", async () => {
    const nullStart = simple("null-start", { caseStartedAt: null });
    const nullEnd = simple("null-end", { caseEndedAt: null, outcome: "completed" });
    const facts = ["a", "b", "c"].flatMap((id) => simple(id));
    const result = await fake([...facts, ...nullStart, ...nullEnd]).query(
      query({ kind: "case-counts" }, { groupBy: [] }),
    );
    expect(result.rows[0]).toMatchObject({ count: 3, observedCases: 3, censoredCases: 0 });
    expect(result.metadata.coverage).toEqual({ eligibleCases: 4, coveredCases: 3, ratio: 0.75 });
  });
  it.each([
    { enteredAt: null },
    { enteredAt: "2026-01-01T00:00:00.000Z" },
    { enteredAt: "2026-01-03T00:00:00.000Z" },
    { exitedAt: "2026-01-13T00:00:00.000Z" },
    { exitedAt: null },
  ])("excludes the whole case dwell when a visit has invalid time %j", async (patch) => {
    const facts = simple("a");
    const invalid = facts
      .filter((fact) => fact.kind === "interval")
      .map((fact) => ({ ...fact, factId: "bad-visit", ...patch }) as LifecycleFact);
    const result = await fake([...facts, ...invalid]).query(query());
    expect(result.rows).toEqual([]);
  });
  it("queries late corrections by knowledge time, replaces old intervals, then filters outcomes", async () => {
    const original = ["a", "b", "c"]
      .flatMap((id) =>
        simple(id, { outcome: "open", caseEndedAt: null, recordedAt: "2026-01-03T00:00:00.000Z" }),
      )
      .map((fact) => (fact.kind === "interval" ? { ...fact, exitedAt: null } : fact));
    const correction = ["a", "b", "c"].flatMap((id) =>
      simple(id, { revision: 2, recordedAt: "2026-01-11T00:00:00.000Z" }),
    );
    const adapter = fake([...original, ...correction]);
    const before = await adapter.query(
      query({ kind: "case-counts" }, { asOf: "2026-01-10T00:00:00.000Z", groupBy: [] }),
    );
    const after = await adapter.query(
      query(
        { kind: "case-counts" },
        { groupBy: [], filters: [{ field: "outcome", values: ["open"] }] },
      ),
    );
    expect(before.rows[0]).toMatchObject({ censoredCases: 3, observedCases: 0 });
    expect(after.rows).toEqual([]);
    const dwell = await adapter.query(query(undefined, { groupBy: [] }));
    expect(dwell.rows[0]).toMatchObject({ count: 3, p50Ms: 3600000 });
  });
  it("exposes a lagging source watermark without claiming freshness", async () => {
    const facts = simple("a", { recordedAt: "2026-01-03T00:00:00.000Z" });
    const result = await fake(facts, demoRegistry, "2026-01-04T00:00:00.000Z").query(query());
    expect(result.metadata.watermark).toBe("2026-01-04T00:00:00.000Z");
    expect(result.metadata.asOf).toBe(demoWatermark);
  });
  it("suppresses small counts, percentiles, coverage numerator/ratio and metadata sample size", async () => {
    const result = await fake(simple("a")).query(query());
    expect(result.rows[0]).toMatchObject({
      sampleSize: null,
      count: null,
      observedCases: null,
      censoredCases: null,
      p50Ms: null,
      p75Ms: null,
      p90Ms: null,
      suppressed: true,
    });
    expect(result.metadata).toMatchObject({
      sampleSize: null,
      coverage: { eligibleCases: null, coveredCases: null, ratio: null },
      suppression: { suppressedRows: 1 },
    });
  });
  it("suppresses both complementary counts when only one count is small", async () => {
    const result = await fake().query(query({ kind: "case-counts" }, { groupBy: [] }));
    expect(result.rows[0]).toMatchObject({ count: 12, observedCases: null, censoredCases: null });
  });
  it("copies fixture/policy inputs and query metadata", async () => {
    const facts = syntheticFacts(),
      registry = structuredClone(demoRegistry),
      input = structuredClone(demoQuery);
    const adapter = fake(facts, registry);
    facts.length = 0;
    registry.minSampleSize = 100;
    const result = await adapter.query(input);
    input.cohort.id = "before";
    expect(result.rows[0]?.sampleSize).toBe(6);
    expect(result.metadata.cohort.id).toBe("after");
  });
});

describe("SQL execution contract", () => {
  it.each([
    { kind: "stage-dwell", stageId: "review" },
    { kind: "current-open-age" },
    { kind: "outcomes" },
    { kind: "funnel", checkpoints: ["start", "finish"] },
    { kind: "variant-counts" },
    { kind: "case-counts" },
    {
      kind: "comparison",
      stageId: "review",
      reference: { id: "before", caseMix: ["routine", "urgent"] },
    },
  ] as Metric[])(
    "executes portable SQL for $kind with parity against independent fake aggregation",
    async (metric) => {
      const facts = syntheticFacts(),
        q = query(metric),
        store = sqlFixture(facts);
      try {
        const adapter = createBasinAdapter(demoRegistry, async (plan) => ({
          rows: store.execute(plan),
          evidence: {
            ...evidence,
            eligibleCases: metric.kind === "comparison" ? 24 : 12,
            coveredCases: metric.kind === "comparison" ? 24 : 12,
          },
        }));
        const actual = await adapter.query(q),
          expected = await fake(facts).query(q);
        expect(actual.rows).toEqual(expected.rows);
        expect(actual.metadata.approximation).toBe("basin-approx-percentile");
        expect(actual.metadata.coverage).toEqual(expected.metadata.coverage);
      } finally {
        store.close();
      }
    },
  );
  it("overfetches one complete group to detect truncation including both comparison arms", async () => {
    const store = sqlFixture(syntheticFacts());
    try {
      for (const metric of [
        demoQuery.metric,
        {
          kind: "comparison",
          stageId: "review",
          reference: { id: "before", caseMix: ["routine", "urgent"] },
        },
      ] as Metric[]) {
        const n = metric.kind === "comparison" ? 24 : 12;
        const adapter = createBasinAdapter(demoRegistry, async (plan) => ({
          rows: store.execute(plan),
          evidence: { ...evidence, eligibleCases: n, coveredCases: n },
        }));
        const result = await adapter.query(query(metric, { topN: 1 }));
        expect(result.metadata.truncated).toBe(true);
        expect(result.rows).toHaveLength(1);
      }
    } finally {
      store.close();
    }
  });
  it("selects revisions before mutable cohort, version and outcome filters; SQL replay is idempotent", async () => {
    const facts = ["a", "b", "c"].flatMap((id) =>
      simple(id, { outcome: "open", caseEndedAt: null, recordedAt: "2026-01-03T00:00:00.000Z" }),
    );
    const corrections = ["a", "b", "c"].flatMap((id) =>
      simple(id, { revision: 2, recordedAt: "2026-01-11T00:00:00.000Z" }),
    );
    const store = sqlFixture([...facts, ...facts, ...corrections]);
    try {
      const q = query({ kind: "case-counts" }, { groupBy: [] });
      expect(store.execute(buildBasinSql(q, demoRegistry))[0]).toMatchObject({
        count: 3,
        observedCases: 3,
        censoredCases: 0,
      });
      expect(
        store.execute(
          buildBasinSql({ ...q, filters: [{ field: "outcome", values: ["open"] }] }, demoRegistry),
        ),
      ).toEqual([]);
      expect(
        store.execute(buildBasinSql({ ...q, asOf: "2026-01-10T00:00:00.000Z" }, demoRegistry))[0],
      ).toMatchObject({ count: 3, censoredCases: 3 });
    } finally {
      store.close();
    }
  });
  it("includes read-only operations, tenant, partition, time, version, LIMIT and percentile guards", () => {
    const plan = buildBasinSql(query(), demoRegistry, "catalog.analytics.lifecycle_facts");
    expect(plan.readOnly).toBe(true);
    expect(plan.dialect).toBe("basin-datafusion-candidate");
    expect(plan.sql).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|COPY|CALL)\b|;|--|\/\*/i,
    );
    for (const text of [
      '"catalog"."analytics"."lifecycle_facts"',
      "app_id = 'demo'",
      "definition_id = 'intake'",
      "cohort_day >= '2026-01-01'",
      "case_started_at_ms >=",
      "case_started_at_ms <",
      "recorded_at_ms <=",
      "definition_version IN",
      "APPROX_PERCENTILE_CONT",
      "LIMIT 21",
      "revision_rank = 1",
      "duplicate_rank = 1",
    ])
      expect(plan.sql).toContain(text);
  });
  it("fails before execution for unsafe input and propagates failures without success metadata", async () => {
    const execute = vi.fn(async () => {
      throw new Error("query timeout");
    });
    const adapter = createBasinAdapter(demoRegistry, execute);
    await expect(adapter.query(query(undefined, { topN: 1000 }))).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
    await expect(adapter.query(query())).rejects.toThrow(/timeout/);
  });
  it("rejects malformed, duplicate, over-limit or inconsistent executor results", async () => {
    const q = query(undefined, { groupBy: [] });
    for (const patch of [
      { sampleSize: -1 },
      { sampleSize: 1.2 },
      { count: 2 },
      { observedCases: 2 },
      { censoredCases: 1 },
      { p50Ms: NaN },
      { p50Ms: -1 },
      { p75Ms: 0 },
      { p90Ms: null },
      { key: 5 },
      { arm: "other" },
      { group: { caseMix: "routine" } },
    ]) {
      const adapter = createBasinAdapter(demoRegistry, async () => ({
        rows: [{ ...raw, ...patch } as AggregateRow],
        evidence,
      }));
      await expect(adapter.query(q)).rejects.toThrow();
    }
    for (const rows of [[raw, raw], Array.from({ length: 22 }, () => raw)])
      await expect(
        createBasinAdapter(demoRegistry, async () => ({ rows, evidence })).query(q),
      ).rejects.toThrow();
    for (const data of [
      { ...evidence, coveredCases: -1 },
      { ...evidence, eligibleCases: 2 },
      { ...evidence, watermark: "2026-01-13T00:00:00.000Z" },
    ])
      await expect(
        createBasinAdapter(demoRegistry, async () => ({ rows: [raw], evidence: data })).query(q),
      ).rejects.toThrow();
  });
  it("preserves unknown coverage and protects in-flight requests from caller/executor mutation", async () => {
    const input = query(undefined, { groupBy: [] });
    const registry = structuredClone(demoRegistry);
    const adapter = createBasinAdapter(registry, async (_plan, executorQuery) => {
      executorQuery.cohort.id = "before";
      input.cohort.id = "before";
      registry.minSampleSize = 100;
      return { rows: [raw], evidence: { ...evidence, eligibleCases: null } };
    });
    const result = await adapter.query(input);
    expect(result.metadata.coverage).toEqual({
      eligibleCases: null,
      coveredCases: 12,
      ratio: null,
    });
    expect(result.metadata.cohort.id).toBe("after");
    expect(result.rows[0]).toMatchObject({ sampleSize: 3, suppressed: false });
  });
});

describe("SQL quality and snapshot parity regressions", () => {
  it.each([
    { kind: "stage-dwell", stageId: "review" },
    { kind: "case-counts" },
    { kind: "outcomes" },
    { kind: "funnel", checkpoints: ["start", "finish"] },
  ] as Metric[])(
    "keeps null/invalid times, unknown variants, malformed funnel order and revisions consistent for $kind",
    async (metric) => {
      const facts = syntheticFacts();
      for (const fact of facts) {
        if (fact.caseId === "after-routine-1") fact.caseStartedAt = null;
        if (fact.caseId === "after-routine-2") fact.caseEndedAt = null;
        if (fact.caseId === "after-routine-3" && fact.kind === "interval") fact.enteredAt = null;
        if (
          fact.caseId === "after-routine-4" &&
          fact.kind === "checkpoint" &&
          fact.checkpointId === "done"
        )
          fact.sequence = 0;
        if (fact.caseId === "after-urgent-1") fact.variantId = "unmapped";
      }
      const q = query(metric, { groupBy: [] });
      const expected = await fake(facts).query(q);
      const store = sqlFixture([...facts, ...facts]);
      try {
        const adapter = createBasinAdapter(demoRegistry, async (plan) => ({
          rows: store.execute(plan),
          evidence: { ...evidence, eligibleCases: 11, coveredCases: 9 },
        }));
        const actual = await adapter.query(q);
        expect(actual.rows).toEqual(expected.rows);
        expect(actual.metadata.coverage).toEqual(expected.metadata.coverage);
      } finally {
        store.close();
      }
    },
  );
  it("does not resurrect a prior version when the current version/cohort no longer matches", async () => {
    const original = ["a", "b", "c"].flatMap((id) => simple(id));
    const corrections = ["a", "b", "c"].flatMap((id) =>
      simple(id, { revision: 2, cohortId: "before", definitionVersion: "v3" }),
    );
    const facts = [...original, ...corrections],
      q = query({ kind: "case-counts" }, { groupBy: [] });
    const store = sqlFixture(facts);
    try {
      expect((await fake(facts).query(q)).rows).toEqual([]);
      expect(store.execute(buildBasinSql(q, demoRegistry))).toEqual([]);
    } finally {
      store.close();
    }
  });
  it("reports row-level percentile suppression even when total sample is sufficient", async () => {
    const facts = ["a", "b", "c"]
      .flatMap((id) => simple(id, { outcome: "open", caseEndedAt: null }))
      .map((fact) => (fact.kind === "interval" ? { ...fact, exitedAt: null } : fact));
    const result = await fake(facts).query(query(undefined, { groupBy: [] }));
    expect(result.rows[0]).toMatchObject({
      sampleSize: 3,
      p50Ms: null,
      suppression: { sample: false, counts: false, percentiles: true },
    });
    expect(result.metadata.suppression.suppressedRows).toBe(1);
  });
  it("enforces half-open cohort bounds, including non-midnight timestamps", async () => {
    const q = query({ kind: "case-counts" }, { from: "2026-01-02T00:00:00.001Z", groupBy: [] });
    expect((await fake().query(q)).rows).toEqual([]);
    const store = sqlFixture(syntheticFacts());
    try {
      expect(store.execute(buildBasinSql(q, demoRegistry))).toEqual([]);
    } finally {
      store.close();
    }
  });
});

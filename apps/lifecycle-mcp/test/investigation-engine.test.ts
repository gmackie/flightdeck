import {
  type Budget,
  type EvidencePack,
  executeInvestigation,
  type InvestigationCatalog,
  parseEvidencePack,
  planInvestigation,
  serializeEvidencePack,
} from "@flightdeckhq/lifecycle-investigations";
import { createFakeAdapter, type QueryAdapter } from "@flightdeckhq/lifecycle-queries";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import {
  AS_OF,
  catalogFor,
  DOMAINS,
  factsFor,
  requestFor,
} from "../../../packages/lifecycle-investigations/test/fixtures";
import {
  createInvestigationAdmission,
  ENGINE_LIMITS,
  type InvestigationEngineConfig,
} from "../src/investigation-engine-adapter";
import { packageEvidenceSchema, packagePlanSchema } from "../src/investigation-engine-contract";
import type { AppScope } from "../src/source";
import { type Deps, handleRequest } from "../src/worker";
import {
  call,
  connect,
  ENV,
  keys,
  MCP_URL,
  NOW,
  PROTOCOL,
  serviceToken,
  synthetic,
  userToken,
} from "./helpers";

function fixture(name: "hiring" | "deploy" = "deploy") {
  const domain = DOMAINS[name];
  const catalog: InvestigationCatalog = catalogFor(domain);
  catalog.registry.minSampleSize = 5;
  catalog.policy = { ...catalog.policy, maxWatermarkLagMs: 900_000 };
  const facts = factsFor(domain, { currentOpenCases: 0 });
  const fake = createFakeAdapter(facts, catalog.registry, AS_OF);
  const query = vi.fn(fake.query.bind(fake));
  const adapter: QueryAdapter = { query: query as QueryAdapter["query"] };
  const grantsFor = vi.fn(async () => [
    { appId: domain.appId, role: "analyst" as const, expiresAt: null },
  ]);
  const legacy = synthetic();
  legacy.grantsFor = grantsFor;
  const adapterFor = vi.fn((_scope: AppScope) => adapter);
  const config: InvestigationEngineConfig = {
    source: { kind: "fixture", historicalAsOf: true, catalogs: [catalog], adapterFor },
    admit: createInvestigationAdmission(() => NOW),
  };
  const request = requestFor(domain, "intervention-review", { stages: [domain.interventionStage] });
  const input = { contract_version: "package-investigation@1", request };
  const deps: Deps = { keys, now: () => NOW, source: legacy, investigationEngine: config };
  async function client(token?: string) {
    const c = new Client(
      { name: "engine-integration", version: "1" },
      { versionNegotiation: { mode: { pin: PROTOCOL } } },
    );
    await c.connect(
      new StreamableHTTPClientTransport(new URL(MCP_URL), {
        requestInit: { headers: { "Cf-Access-Jwt-Assertion": token ?? (await userToken()) } },
        fetch: (url, init) => handleRequest(new Request(url, init), ENV, deps),
      }),
    );
    return c;
  }
  return {
    domain,
    catalog,
    adapter,
    query,
    grantsFor,
    adapterFor,
    config,
    input,
    request,
    client,
    legacy,
  };
}
async function collect(f: ReturnType<typeof fixture>) {
  const client = await f.client();
  const plan = await call(client, "plan_process_investigation", f.input);
  expect(plan.isError, plan.text).toBe(false);
  const result = await call(client, "execute_process_investigation", {
    ...f.input,
    expected_plan_digest: plan.data.plan.digest,
  });
  await client.close();
  return { plan, result };
}

describe("optional package v1 engine over the actual MCP v2 handler", () => {
  it("preserves the PR47 default surface and explicitly refuses an unavailable engine", async () => {
    const legacy = await connect();
    expect((await legacy.listTools()).tools.map((tool) => tool.name)).not.toContain(
      "plan_process_investigation",
    );
    await legacy.close();
    const f = fixture();
    f.config.source = null;
    const client = await f.client();
    const result = await call(client, "plan_process_investigation", f.input);
    expect(result.error?.code).toBe("engine_unavailable");
    expect(f.query).not.toHaveBeenCalled();
    await client.close();
  });

  it.each(["hiring", "deploy"] as const)(
    "prompt → plan → collect reconciles %s with direct library results",
    async (name) => {
      const f = fixture(name);
      const client = await f.client();
      const prompt = await client.getPrompt({
        name: "evaluate_intervention",
        arguments: {
          app_id: f.domain.appId,
          workflow_key: f.domain.definitionId,
        },
      });
      expect(JSON.stringify(prompt)).toContain("plan_process_investigation");
      const tools = (await client.listTools()).tools.filter((tool) =>
        tool.name.endsWith("process_investigation"),
      );
      expect(tools).toHaveLength(2);
      for (const tool of tools) {
        expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
        expect(tool.inputSchema.additionalProperties).toBe(false);
        expect(tool.outputSchema?.additionalProperties).toBe(false);
      }
      const plan = await call(client, "plan_process_investigation", f.input);
      expect(plan.isError, plan.text).toBe(false);
      expect(f.query).not.toHaveBeenCalled();
      const budget: Budget = { ...ENGINE_LIMITS, maxQueries: 14, maxStages: 6, maxWindowDays: 31 };
      const request = { ...f.request, budget };
      const directPlan = planInvestigation(request, f.catalog, { now: () => NOW });
      expect(plan.data.plan).toEqual(directPlan);
      const result = await call(client, "execute_process_investigation", {
        ...f.input,
        expected_plan_digest: directPlan.digest,
      });
      expect(result.isError, result.text).toBe(false);
      const direct = await executeInvestigation(request, {
        catalog: f.catalog,
        adapter: f.adapter,
        authorize: () => ({ allowed: true, appId: f.domain.appId, scopeKey: "fixture-grant" }),
        now: () => NOW,
      });
      expect(result.data.pack).toEqual(direct.pack);
      expect(packageEvidenceSchema.safeParse(direct.pack).success).toBe(true);
      const pack = result.data.pack as EvidencePack;
      expect(parseEvidencePack(serializeEvidencePack(pack))).toEqual(pack);
      const rows = pack.evidence.flatMap((entry) => entry.rows);
      expect(rows.some((row) => row.deltaP50Ms !== null && row.deltaP50Ms < 0)).toBe(true);
      expect(
        pack.findings.some(
          (finding) => finding.kind === "cohort-dwell-difference" && finding.status === "observed",
        ),
      ).toBe(true);
      expect(rows.every((row) => /^q:.+#\d+$/.test(row.ref))).toBe(true);
      expect(result.text).toContain("non-causal");
      expect(result.text).not.toContain(pack.findings[0]?.statement);
      expect(result.data.source).toEqual({ kind: "fixture", historical_as_of: true });
      expect(JSON.stringify(pack)).not.toMatch(/deploy-current-|hiring-current-|analyst@example/);
      expect(
        f.adapterFor.mock.calls.every(
          ([scope]) => scope.appId === f.domain.appId && scope.capability === "process:read",
        ),
      ).toBe(true);
      expect(packagePlanSchema.safeParse({ ...directPlan, extra: true }).success).toBe(false);
      expect(packageEvidenceSchema.safeParse({ ...pack, extra: true }).success).toBe(false);
      expect(
        packageEvidenceSchema.safeParse({ ...pack, scope: { ...pack.scope, extra: true } }).success,
      ).toBe(false);
      await client.close();
    },
  );

  it.each(["no grant", "reader", "service", "other app", "grant failure"])(
    "denies %s before any query or adapter creation",
    async (reason) => {
      const f = fixture();
      if (reason === "no grant") f.grantsFor.mockResolvedValue([]);
      if (reason === "reader")
        f.grantsFor.mockResolvedValue([
          { appId: f.domain.appId, role: "reader", expiresAt: null },
        ] as never);
      if (reason === "grant failure")
        f.grantsFor.mockRejectedValue(new Error("secret upstream detail"));
      const client = await f.client(reason === "service" ? await serviceToken() : undefined);
      const result = await call(
        client,
        "plan_process_investigation",
        reason === "other app"
          ? { ...f.input, request: { ...f.request, appId: "other-app" } }
          : f.input,
      );
      expect(result.isError).toBe(true);
      expect(result.error?.code).toBe(
        reason === "grant failure" ? "source_unavailable" : "forbidden",
      );
      expect(result.text).not.toContain("secret");
      expect(f.query).not.toHaveBeenCalled();
      expect(f.adapterFor).not.toHaveBeenCalled();
      await client.close();
    },
  );

  it("refuses foreign registry, definition versions and unsupported relationship graphs without queries", async () => {
    const f = fixture();
    const client = await f.client();
    for (const request of [
      { ...f.input, request: { ...f.request, definitionVersions: ["unknown"] } },
      { ...f.input, request: { ...f.request, definitionVersions: ["v1", "v3"] } },
      { ...f.input, request: { ...f.request, definitionId: "foreign-definition" } },
      { ...f.input, dependency_scope: "child_dependencies" },
      { ...f.input, contract_version: "package-investigation@2" },
      { ...f.input, request: { ...f.request, metricVersion: "lifecycle.v2" } },
      { ...f.input, sql: "SELECT private" },
      { ...f.input, request: { ...f.request, caseId: "raw-case" } },
    ])
      expect((await call(client, "plan_process_investigation", request)).isError).toBe(true);
    f.catalog.registry.appId = "foreign-app";
    expect((await call(client, "plan_process_investigation", f.input)).error?.code).toBe(
      "unsupported",
    );
    expect(f.query).not.toHaveBeenCalled();
    await client.close();
  });

  it("rechecks grants during planning, dispatch, and before releasing evidence", async () => {
    const f = fixture();
    const client = await f.client();
    const plan = await call(client, "plan_process_investigation", f.input);
    expect(plan.isError, plan.text).toBe(false);
    f.query.mockImplementation(async (query) => {
      const result = await createFakeAdapter(
        factsFor(f.domain, { currentOpenCases: 0 }),
        f.catalog.registry,
        AS_OF,
      ).query(query);
      f.grantsFor.mockResolvedValue([]);
      return result;
    });
    const result = await call(client, "execute_process_investigation", {
      ...f.input,
      expected_plan_digest: plan.data.plan.digest,
    });
    expect(result.error?.code).toBe("forbidden");
    expect(result.data).toBeNull();
    expect(f.grantsFor.mock.calls.length).toBeGreaterThan(5);
    await client.close();
  });

  it("denies a changed grant revision even if the new grant still allows reads", async () => {
    const f = fixture();
    const client = await f.client();
    const plan = await call(client, "plan_process_investigation", f.input);
    f.grantsFor
      .mockResolvedValueOnce([{ appId: f.domain.appId, role: "analyst", expiresAt: null }])
      .mockResolvedValueOnce([{ appId: f.domain.appId, role: "analyst", expiresAt: null }])
      .mockResolvedValue([{ appId: f.domain.appId, role: "owner", expiresAt: null }] as never);
    const result = await call(client, "execute_process_investigation", {
      ...f.input,
      expected_plan_digest: plan.data.plan.digest,
    });
    expect(result.error?.code).toBe("forbidden");
    expect(f.query).not.toHaveBeenCalled();
    await client.close();
  });

  it.each(["small", "stale", "unknown", "foreign result"])(
    "retains honest cannot-determine evidence for %s source data",
    async (mode) => {
      const f = fixture();
      if (mode === "small") {
        f.query.mockImplementation(
          createFakeAdapter(
            factsFor(f.domain).filter((fact) => fact.caseId.endsWith("-1")),
            f.catalog.registry,
            AS_OF,
          ).query,
        );
      } else {
        const inner = createFakeAdapter(
          factsFor(f.domain, { currentOpenCases: 0 }),
          f.catalog.registry,
          mode === "stale" ? "2026-02-01T00:00:00.000Z" : AS_OF,
        );
        f.query.mockImplementation(async (query) => {
          const result = await inner.query(query);
          if (mode === "unknown")
            (result.metadata as unknown as { watermark: null }).watermark = null;
          if (mode === "foreign result") result.metadata.appId = "other-app";
          return result;
        });
      }
      const { result } = await collect(f);
      expect(result.isError, result.text).toBe(false);
      const pack = result.data.pack as EvidencePack;
      expect(pack.findings.every((finding) => finding.status !== "observed")).toBe(true);
      if (mode === "small") {
        expect(
          pack.evidence
            .flatMap((entry) => entry.rows)
            .every((row) => row.sample?.sampleSize === null),
        ).toBe(true);
      }
      if (mode === "stale") expect(pack.warnings).toContain("stale-watermark");
      if (mode === "unknown" || mode === "foreign result")
        expect(pack.evidence.some((entry) => entry.status === "invalid_result")).toBe(true);
    },
  );

  it("enforces plan query/cost caps, source rows and expected plan digest", async () => {
    const f = fixture();
    const client = await f.client();
    for (const budget of [{ maxQueries: 1 }, { maxCostUnits: 1 }]) {
      const result = await call(client, "plan_process_investigation", {
        ...f.input,
        request: { ...f.request, budget },
      });
      expect(result.error?.code).toBe("budget_exceeded");
    }
    const plan = await call(client, "plan_process_investigation", f.input);
    expect(
      (
        await call(client, "execute_process_investigation", {
          ...f.input,
          expected_plan_digest: "0".repeat(64),
        })
      ).error?.code,
    ).toBe("invalid_argument");
    expect(f.query).not.toHaveBeenCalled();
    const inner = createFakeAdapter(factsFor(f.domain), f.catalog.registry, AS_OF);
    f.query.mockImplementation(async (query) => {
      const result = await inner.query(query);
      result.rows = Array.from({ length: 21 }, () => result.rows[0]) as typeof result.rows;
      return result;
    });
    expect(
      (
        await call(client, "execute_process_investigation", {
          ...f.input,
          expected_plan_digest: plan.data.plan.digest,
        })
      ).error?.code,
    ).toBe("budget_exceeded");
    await client.close();
  });

  it("enforces per-principal rate and cost admission before adapter access", async () => {
    const f = fixture();
    const client = await f.client();
    for (let index = 0; index < 10; index++)
      expect((await call(client, "plan_process_investigation", f.input)).isError).toBe(false);
    expect((await call(client, "plan_process_investigation", f.input)).error?.code).toBe(
      "budget_exceeded",
    );
    expect(f.query).not.toHaveBeenCalled();
    const admit = createInvestigationAdmission(() => NOW);
    expect(admit("one", 1_200)).toBe(true);
    expect(admit("one", 1)).toBe(false);
    expect(admit("two", 1)).toBe(true);
    await client.close();
  });

  it("bounds timed-out queries without scheduling late source work", async () => {
    const f = fixture();
    f.input.request.budget = { queryTimeoutMs: 10, totalTimeoutMs: 30, maxConcurrency: 1 };
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inner = createFakeAdapter(factsFor(f.domain), f.catalog.registry, AS_OF);
    f.query.mockImplementation(async (query) => {
      await pending;
      return inner.query(query);
    });
    const { result } = await collect(f);
    expect(result.isError, result.text).toBe(false);
    expect(
      result.data.pack.evidence.some((entry: { status: string }) => entry.status === "timeout"),
    ).toBe(true);
    expect(f.query).toHaveBeenCalledTimes(1);
    const frozen = serializeEvidencePack(result.data.pack);
    release?.();
    await pending;
    expect(serializeEvidencePack(result.data.pack)).toBe(frozen);
    expect(f.query).toHaveBeenCalledTimes(1);
  });

  it("rejects a full evidence response over the existing MCP output size ceiling", async () => {
    const f = fixture("hiring");
    const mixes = ["standard", "priority", "urgent", "routine"];
    f.catalog.registry.filterValues = { ...f.catalog.registry.filterValues, caseMix: mixes };
    const facts = factsFor(f.domain, { currentOpenCases: 0 });
    const extra = facts.map((fact) => ({
      ...fact,
      caseId: `extra-${fact.caseId}`,
      factId: `extra-${fact.factId}`,
      caseMix: fact.caseMix === "standard" ? "urgent" : "routine",
    }));
    f.query.mockImplementation(
      createFakeAdapter([...facts, ...extra], f.catalog.registry, AS_OF).query,
    );
    f.input.request = requestFor(f.domain, "process-health", {
      cohort: { id: "control", caseMix: mixes },
      groupBy: ["variantId"],
    });
    const { result } = await collect(f);
    expect(result.error?.code).toBe("result_too_large");
    expect(result.data).toBeNull();
  });

  it("validates client analysis with the package and never generates claim text", async () => {
    const f = fixture();
    // A compact health request leaves input room within MCP's existing 64-element ceiling.
    f.input.request = requestFor(f.domain, "process-health", { stages: ["review"] });
    const { result, plan } = await collect(f);
    expect(result.isError, result.text).toBe(false);
    const pack = result.data.pack as EvidencePack;
    const client = await f.client();
    const analysis = {
      evidencePackId: pack.id,
      claims: [
        {
          claim: "The intervention caused a 900% improvement.",
          kind: "observation",
          findingIds: [] as string[],
          evidenceRefs: [] as string[],
          uncertainty: { level: "high", notes: "unverified" },
          counterevidence: [],
          actionProposal: { kind: "none", description: "" },
        },
      ],
      missingEvidence: [],
      nextMeasurements: [],
    };
    const invalid = await call(client, "execute_process_investigation", {
      ...f.input,
      expected_plan_digest: plan.data.plan.digest,
      analysis,
    });
    expect(invalid.isError, invalid.text).toBe(false);
    expect(invalid.data.validation.valid).toBe(false);
    expect(invalid.data.validation.issues).toContainEqual({ claim: 0, issue: "causal-language" });
    expect(invalid.text).not.toContain("900%");
    const finding = pack.findings.find((item) => item.evidenceRefs.length > 0);
    expect(finding).toBeDefined();
    if (!finding) throw new Error("Expected a determinable synthetic finding");
    const grounded = structuredClone(analysis);
    const claim = grounded.claims[0];
    if (!claim) throw new Error("Expected fixture claim");
    grounded.claims[0] = {
      ...claim,
      kind: finding.status === "cannot_determine" ? "cannot_determine" : "observation",
      claim: finding.statement,
      findingIds: [finding.id],
      evidenceRefs: [...finding.evidenceRefs],
    };
    // Preserve the exact package finding and row references; no narrative is generated.
    const valid = await call(client, "execute_process_investigation", {
      ...f.input,
      expected_plan_digest: plan.data.plan.digest,
      analysis: grounded,
    });
    expect(valid.isError, valid.text).toBe(false);
    expect(valid.data.validation).toEqual({ valid: true, issues: [] });
    if (grounded.claims[0]) grounded.claims[0].evidenceRefs = ["q:foreign#0"];
    const foreign = await call(client, "execute_process_investigation", {
      ...f.input,
      expected_plan_digest: plan.data.plan.digest,
      analysis: grounded,
    });
    expect(foreign.isError, foreign.text).toBe(false);
    expect(foreign.data.validation.valid).toBe(false);
    expect(foreign.data.validation.issues).toContainEqual({ claim: 0, issue: "unknown-ref" });
    await client.close();
  });
});

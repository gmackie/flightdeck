import { env } from "cloudflare:workers";
import type { LifecycleEventInput } from "@flightdeckhq/schema";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import recruiting from "../../../examples/lifecycle-fixtures/fixtures/scenarios/recruiting-repeat-assessment-delayed-scorecard.json";
import deployment from "../../../examples/lifecycle-fixtures/fixtures/scenarios/service-regional-rollouts.json";
import { Authorizer } from "../../lifecycle-mcp/src/authorize";
import type { AppScope, Principal } from "../../lifecycle-mcp/src/source";
import { ReadApiLifecycleSource } from "../../lifecycle-mcp/src/sources/read-api";
import { handleRequest } from "../../lifecycle-mcp/src/worker";
import { processRegistration } from "../src/ingest/lifecycle-http";
import { privateLifecycleRead } from "../src/lifecycle-mcp/entrypoint";
import { LifecycleSnapshotRepository } from "../src/lifecycle-serving/repository";
import { adaptFixtures } from "./support/fixture-adapter";
import { deliver, grant, type Json, producerApp, project } from "./support/harness";

const TEAM = "https://mcp-live.cloudflareaccess.com";
const AUD = "mcp-aud";
const APP = "app_mcp_live";
const OTHER = "app_mcp_other";
const pair = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(pair.publicKey)), kid: "live", alg: "RS256" };
const keys = createLocalJWKSet({ keys: [jwk] });
const source = new ReadApiLifecycleSource(env.TEST_LIFECYCLE_READ);
const config = {
  LIFECYCLE_MCP_ENVIRONMENT: "staging",
  LIFECYCLE_MCP_SOURCE: "read-api",
  ACCESS_TEAM_DOMAIN: TEAM,
  ACCESS_AUD: AUD,
  LIFECYCLE_READ_API: env.TEST_LIFECYCLE_READ,
};
const jwt = (
  sub = "live-analyst",
  audience = AUD,
  claims: Record<string, unknown> = { email: "synthetic@example.test" },
) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "live" })
    .setSubject(sub)
    .setIssuer(TEAM)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(pair.privateKey);
let assertion: string;
const principal = (): Principal => ({ sub: "forged-ignored", serviceToken: false, assertion });
const scope = (appId = APP): AppScope =>
  ({ appId, principal: principal(), capability: "process:read" }) as AppScope;
async function connect(token = assertion) {
  const client = new Client(
    { name: "live-d1-acceptance", version: "1" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL("https://mcp.test/mcp"), {
      requestInit: { headers: { "Cf-Access-Jwt-Assertion": token } },
      fetch: (url, init) => handleRequest(new Request(url, init), config, { keys }),
    }),
  );
  return client;
}
async function call(client: Client, name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  return {
    error: res.isError
      ? JSON.parse((res.content as { text: string }[])[0]?.text ?? "{}").error
      : null,
    data: res.structuredContent as Json,
  };
}

beforeAll(async () => {
  // JWKS HTTP is deterministic; BOTH workers still perform real RS256 issuer/AUD verification.
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input) !== `${TEAM}/cdn-cgi/access/certs`)
      throw new Error("Unexpected network request");
    return Response.json({ keys: [jwk] });
  });
  assertion = await jwt();
  const producer = await producerApp(APP);
  await producerApp(OTHER);
  await grant("live-analyst", "analyst", APP);
  await grant("live-reader", "reader", APP, "service");
  const adapted = await adaptFixtures([...recruiting.records, ...deployment.records]);
  for (const events of adapted.byApp.values()) await deliver(producer, events);
  await project(APP);
});
afterAll(() => vi.restoreAllMocks());

describe("private named entrypoint -> verified MCP assertion -> migrated D1 -> MCP v2", () => {
  it("reads both fixture domains and parent/child cases through the real named binding", async () => {
    const client = await connect();
    try {
      const defs = await call(client, "list_workflow_definitions", { app_id: APP, limit: 50 });
      expect(defs.error).toBeNull();
      const names = defs.data.data.definitions.map((d: Json) => d.workflow_key);
      expect(names).toContain("recruiting.interview_loop");
      expect(names).toContain("recruiting.assessment");
      expect(names.some((n: string) => n.startsWith("service_delivery."))).toBe(true);
      const { results: cases } = await env.DB.prepare(
        `SELECT case_id, process_key, parent_case_id FROM lifecycle_case_snapshots WHERE app_id = ? AND deleted_at IS NULL`,
      )
        .bind(APP)
        .all<{ case_id: string; process_key: string; parent_case_id: string | null }>();
      const interview = cases.find((c) => c.process_key === "recruiting.interview_loop");
      const child = cases.find(
        (c) => c.process_key === "recruiting.assessment" && c.parent_case_id === interview?.case_id,
      );
      expect(child).toBeDefined();
      for (const c of [
        interview,
        child,
        cases.find((c) => c.process_key.startsWith("service_delivery.")),
      ]) {
        expect(c).toBeDefined();
        const summary = await call(client, "get_case_summary", {
          app_id: APP,
          case_id: c?.case_id,
        });
        expect(summary.error).toBeNull();
        expect(summary.data.data.case.workflow_key).toBe(c?.process_key);
        expect(summary.data.provenance.synthetic).toBe(false);
        const timeline = await call(client, "get_case_timeline", {
          app_id: APP,
          case_id: c?.case_id,
        });
        expect(timeline.error).toBeNull();
        expect(timeline.data.data.entries.length).toBeGreaterThan(0);
      }
      const text = JSON.stringify(defs.data);
      expect(text).not.toContain(assertion);
      expect(text).not.toContain("synthetic@example.test");
      expect(text).not.toMatch(/candidate_notes|scorecard_notes|raw_events/);
    } finally {
      await client.close();
    }
  });

  it("uses the signed identity, never the forged scope principal or app id", async () => {
    const grants = await source.grantsFor(principal());
    expect(grants.map((g) => g.appId)).toContain(APP);
    expect(grants.map((g) => g.appId)).not.toContain(OTHER);
    for (const appId of [OTHER, "app_never_existed", "../app_mcp_live"]) {
      await expect(source.getFreshness(scope(appId))).rejects.toThrow();
      expect(
        await env.TEST_LIFECYCLE_READ.read(assertion, appId, { method: "getFreshness" }),
      ).toEqual({ ok: false, code: "forbidden" });
    }
    const client = await connect();
    try {
      for (const app_id of [OTHER, "app_never_existed"])
        expect((await call(client, "get_data_freshness", { app_id })).error.code).toBe("forbidden");
      expect(
        (await call(client, "get_case_summary", { app_id: APP, case_id: "absent" })).error.code,
      ).toBe("not_found");
    } finally {
      await client.close();
    }
    expect(
      await env.TEST_LIFECYCLE_READ.read(assertion, APP, {
        method: "getFreshness",
        principal: { sub: "live-analyst" },
      }),
    ).toEqual({ ok: false, code: "invalid_argument" });
  });

  it("rejects wrong audience/signature, missing assertion and disabled/unconfigured backend", async () => {
    for (const token of [
      await jwt("live-analyst", "dashboard-aud"),
      await jwt("live-analyst", "other-aud"),
      "garbage",
      "",
    ]) {
      expect(await env.TEST_LIFECYCLE_READ.read(token, APP, { method: "getFreshness" })).toEqual({
        ok: false,
        code: "unauthorized",
      });
    }
    const badPair = await generateKeyPair("RS256");
    const forged = await new SignJWT({ email: "synthetic@example.test" })
      .setProtectedHeader({ alg: "RS256", kid: "live" })
      .setSubject("live-analyst")
      .setIssuer(TEAM)
      .setAudience(AUD)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(badPair.privateKey);
    expect(await env.TEST_LIFECYCLE_READ.read(forged, APP, { method: "getFreshness" })).toEqual({
      ok: false,
      code: "unauthorized",
    });
    for (const overrides of [
      { LIFECYCLE_MCP_READ_ENABLED: "0" },
      { LIFECYCLE_MCP_READ_ENABLED: undefined },
      { LIFECYCLE_MCP_ACCESS_AUD: "" },
      { LIFECYCLE_MCP_ACCESS_AUD: "dashboard-aud" },
    ]) {
      expect(
        await privateLifecycleRead(
          { ...env, ...overrides } as Env,
          assertion,
          APP,
          { method: "getFreshness" },
          keys,
        ),
      ).toEqual({ ok: false, code: "source_unavailable" });
    }
    expect(
      (
        await handleRequest(new Request("https://mcp.test/mcp"), {
          ...config,
          LIFECYCLE_MCP_ENVIRONMENT: "production",
        })
      ).status,
    ).toBe(503);
    expect(
      (
        await handleRequest(new Request("https://mcp.test/mcp"), {
          ...config,
          LIFECYCLE_MCP_SOURCE: "disabled",
        })
      ).status,
    ).toBe(503);
  });

  it("enforces service-reader ceiling even with person-like service claims", async () => {
    const token = await jwt("live-analyst", AUD, {
      common_name: "live-reader",
      email: "synthetic@example.test",
    });
    const client = await connect(token);
    try {
      expect((await call(client, "list_workflow_definitions", { app_id: APP })).error).toBeNull();
      expect(
        (
          await call(client, "get_stage_dwell", {
            app_id: APP,
            workflow_key: "recruiting.assessment",
          })
        ).error.code,
      ).toBe("forbidden");
    } finally {
      await client.close();
    }
    expect(
      await env.TEST_LIFECYCLE_READ.read(token, APP, {
        method: "getStageDwell",
        workflowKey: "recruiting.assessment",
        version: 1,
        from: 0,
        to: 1,
        groupBy: null,
        filters: {},
      }),
    ).toEqual({ ok: false, code: "forbidden" });
  });

  it("rechecks revocation after a scope has already been minted", async () => {
    await grant("live-revoked", "analyst", APP);
    const p: Principal = {
      sub: "live-revoked",
      serviceToken: false,
      assertion: await jwt("live-revoked"),
    };
    const authorized = await new Authorizer(p, source, Date.now).authorize(APP, "lifecycle:read");
    expect("appId" in authorized).toBe(true);
    await env.DB.prepare(
      "UPDATE authz_grants SET revoked_at = ? WHERE principal_subject = 'live-revoked'",
    )
      .bind(Date.now())
      .run();
    await expect(source.getFreshness(authorized as AppScope)).rejects.toThrow();
    expect(await source.grantsFor(p)).toEqual([]);
  });

  it("keeps seq=17 separate from projection time and never claims event-time completeness", async () => {
    await producerApp("app_mcp_seq");
    await grant("live-analyst", "analyst", "app_mcp_seq");
    const repo = new LifecycleSnapshotRepository(env.DB);
    const gen = await repo.beginRebuild("app_mcp_seq");
    await repo.commitRebuild("app_mcp_seq", {
      generation: gen,
      source_watermark: 17,
      as_of: 1_760_000_000_000,
      reducer_version: "lifecycle@1",
    });
    const client = await connect();
    try {
      const res = await call(client, "get_data_freshness", { app_id: "app_mcp_seq" });
      expect(res.error).toBeNull();
      expect(res.data.provenance.projection.source_watermark).toBe(17);
      expect(res.data.provenance.as_of).toBe(new Date(1_760_000_000_000).toISOString());
      expect(res.data.provenance.freshness).toEqual({
        status: "stale",
        watermark: null,
        lag_ms: null,
      });
      expect(res.data.data.watermark).toBeNull();
      expect(res.data.provenance.event_time_completeness).toBe("unknown");
      expect(res.data.interpretation.caveats).toContain(
        "Event-time completeness is unknown. A fresh status means only a recent projection; producer delivery and event coverage are unverified.",
      );
    } finally {
      await client.close();
    }
  });
  it("matches independent fixture dwell values, suppresses small groups, and refuses unsupported semantics", async () => {
    const q = {
      workflowKey: "recruiting.assessment",
      version: 1,
      from: Date.parse("2026-03-01"),
      to: Date.parse("2026-04-01"),
      groupBy: null,
      filters: {},
    };
    const small = await source.getStageDwell(scope(), q);
    expect(small.data.find((g) => g.stage_key === "scorecard_pending")).toMatchObject({
      suppressed: true,
      n: 0,
      p50_ms: null,
    });
    const aggregateApp = "app_mcp_aggregate";
    const key = await producerApp(aggregateApp);
    await grant("live-analyst", "analyst", aggregateApp);
    // Five independent copies of the committed fixture (all identifiers and links remapped).
    for (let copy = 0; copy < 5; copy++) {
      const records = structuredClone([
        ...recruiting.records,
        ...deployment.records,
      ]) as typeof recruiting.records;
      for (const record of records) {
        const e = record.event as Json;
        const suffix = `_copy${copy}`;
        e.eventId += suffix;
        e.entity.id += suffix;
        if (e.stage) e.stage.instanceId += suffix;
        for (const r of e.relations ?? []) r.id += suffix;
        if (e.corrects) e.corrects += suffix;
      }
      for (const events of (await adaptFixtures(records)).byApp.values())
        await deliver(key, events);
    }
    await project(aggregateApp);
    const client = await connect();
    try {
      const args = {
        app_id: aggregateApp,
        workflow_key: "recruiting.assessment",
        version: 1,
        from: "2026-03-01",
        to: "2026-04-01",
      };
      const result = await call(client, "get_stage_dwell", args);
      expect(result.error).toBeNull();
      const want =
        recruiting.expected.apps.app_talent.stages["assessment/scorecard_pending"].closedDwell
          .sumMs;
      expect(want).toBe(9 * 86_400_000);
      expect(
        result.data.data.stages.find((g: Json) => g.stage_key === "scorecard_pending"),
      ).toMatchObject({
        n: 5,
        open_n: 0,
        p50_ms: want,
        p90_ms: want,
        mean_ms: want,
        suppressed: false,
      });
      expect(result.data.provenance.freshness.watermark).toBeNull();
      expect((await call(client, "get_funnel", args)).error.code).toBe("source_unavailable");
      const { version, ...variantArgs } = args;
      expect(
        (
          await call(client, "compare_workflow_variants", {
            ...variantArgs,
            baseline_version: version,
          })
        ).error.code,
      ).toBe("source_unavailable");
    } finally {
      await client.close();
    }
    await expect(
      source.getStageDwell(scope(aggregateApp), { ...q, groupBy: "type" }),
    ).rejects.toThrow();
    // A state segment cannot be passed off as an attempt, or mixed into visit dwell.
    const c = await env.DB.prepare(
      "SELECT case_id FROM lifecycle_case_snapshots WHERE app_id = ? AND process_key = 'recruiting.assessment' LIMIT 1",
    )
      .bind(aggregateApp)
      .first<{ case_id: string }>();
    await env.DB.prepare(
      "UPDATE lifecycle_stage_intervals SET state = 'paused' WHERE app_id = ? AND case_id = ? AND seq = 0",
    )
      .bind(aggregateApp, c?.case_id)
      .run();
    await expect(source.getStageDwell(scope(aggregateApp), q)).rejects.toThrow();
    await expect(
      source.getCaseTimeline(scope(aggregateApp), c?.case_id ?? "", { limit: 20, cursor: null }),
    ).rejects.toThrow();
  });

  it("keeps dotted and underscored registered keys distinct and preserves explicit terminal flags", async () => {
    const appId = "app_mcp_keys";
    await producerApp(appId);
    await grant("live-analyst", "analyst", appId);
    const repo = new LifecycleSnapshotRepository(env.DB);
    const generation = await repo.beginRebuild(appId);
    const p = {
      generation,
      source_watermark: 17,
      as_of: Date.now(),
      reducer_version: "lifecycle@1",
    };
    for (const [key, terminal] of [
      ["delivery.deploy", true],
      ["delivery_deploy", false],
    ] as const) {
      await repo.upsertProcessDefinition(
        appId,
        {
          process_key: key,
          version: 1,
          label: key,
          stages: [{ key: "build", label: "Build", terminal }],
        },
        p,
      );
    }
    await repo.commitRebuild(appId, p);
    const client = await connect();
    try {
      for (const [workflow_key, terminal] of [
        ["delivery.deploy", true],
        ["delivery_deploy", false],
      ] as const) {
        const res = await call(client, "list_workflow_definitions", {
          app_id: appId,
          workflow_key,
        });
        expect(res.error).toBeNull();
        expect(res.data.data.definitions).toHaveLength(1);
        expect(res.data.data.definitions[0]).toMatchObject({
          workflow_key,
          stages: [{ terminal }],
        });
      }
    } finally {
      await client.close();
    }
  });

  it("never supplies synthetic fallback for absent binding, missing projection, or queued projection", async () => {
    const appId = "app_mcp_empty";
    await producerApp(appId);
    await grant("live-analyst", "analyst", appId);
    await expect(source.getFreshness(scope(appId))).rejects.toThrow();
    await expect(new ReadApiLifecycleSource(undefined).getFreshness(scope())).rejects.toThrow();
    const repo = new LifecycleSnapshotRepository(env.DB);
    const generation = await repo.beginRebuild(appId);
    await repo.commitRebuild(appId, {
      generation,
      source_watermark: 0,
      as_of: Date.now(),
      reducer_version: "lifecycle@1",
    });
    expect((await source.getFreshness(scope(appId))).data.status).toBe("fresh");
    await env.DB.prepare(
      "INSERT INTO lifecycle_projection_queue (app_id, case_id, enqueued_seq, next_attempt_at) VALUES (?, 'pending', 1, 0)",
    )
      .bind(appId)
      .run();
    const client = await connect();
    try {
      expect((await call(client, "get_data_freshness", { app_id: appId })).error.code).toBe(
        "source_unavailable",
      );
    } finally {
      await client.close();
    }
  });
  it("preserves build, qa.review and done through HTTP ingest, D1 and full MCP outputs", async () => {
    const appId = "app_mcp_dotted_stages";
    const key = await producerApp(appId);
    await grant("live-analyst", "analyst", appId);
    const definition = {
      schemaVersion: 1,
      processId: "delivery.deploy",
      version: 1,
      name: "Delivery",
      caseType: "deploy",
      stages: ["build", "qa.review", "done"].map((stageId) => ({
        stageId,
        name: stageId,
        terminal: stageId === "done",
      })),
    };
    const register = (body: unknown) =>
      processRegistration(
        new Request("https://flightdeck.test/v1/lifecycle/processes", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
        env,
      );
    expect((await register(definition)).status).toBe(201);
    for (const stageId of [
      "../qa",
      "qa/review",
      "qa%2ereview",
      "qa?notes=secret",
      "qa@example.test",
    ]) {
      expect(
        (
          await register({
            ...definition,
            processId: "bad-stage",
            stages: [{ stageId, name: "Bad" }],
          })
        ).status,
      ).toBe(400);
    }
    const t0 = Date.parse("2026-03-10T00:00:00Z");
    const events: LifecycleEventInput[] = [];
    for (let n = 0; n < 9; n++) {
      const base = {
        schemaVersion: 1 as const,
        processId: definition.processId,
        processVersion: 1,
        caseId: `dotted-case-${n}`,
      };
      events.push({
        ...base,
        sourceSequence: events.length + 1,
        eventId: `dotted_${n}_created`,
        type: "case.created",
        occurredAt: t0,
      });
      for (const [stageId, entered, exited] of [
        ["build", 0, 1000],
        ["qa.review", 1000, 4000],
        ["done", 4000, 5000],
      ] as const) {
        const stageInstanceId = `${n}-${stageId}`;
        events.push({
          ...base,
          sourceSequence: events.length + 1,
          eventId: `dotted_${n}_${entered}_enter`,
          type: "stage.entered",
          stageId,
          stageInstanceId,
          occurredAt: t0 + entered,
        });
        events.push({
          ...base,
          sourceSequence: events.length + 1,
          eventId: `dotted_${n}_${entered}_exit`,
          type: "stage.exited",
          stageId,
          stageInstanceId,
          occurredAt: t0 + exited,
        });
      }
      events.push({
        ...base,
        sourceSequence: events.length + 1,
        eventId: `dotted_${n}_complete`,
        type: "case.completed",
        occurredAt: t0 + 5000,
      });
    }
    await deliver(key, events);
    await project(appId);
    const client = await connect();
    try {
      const args = {
        app_id: appId,
        workflow_key: definition.processId,
        version: 1,
        from: "2026-03-10",
        to: "2026-03-11",
      };
      const defs = await call(client, "list_workflow_definitions", {
        app_id: appId,
        workflow_key: definition.processId,
      });
      expect(defs.error).toBeNull();
      expect(defs.data.data.definitions[0].stages.map((s: Json) => s.key)).toEqual([
        "build",
        "qa.review",
        "done",
      ]);
      const result = await call(client, "get_stage_dwell", args);
      expect(result.error).toBeNull();
      expect(result.data.data.stages).toHaveLength(3);
      expect(result.data.provenance.event_time_completeness).toBe("unknown");
      expect(result.data.provenance.freshness).toEqual({
        status: "fresh",
        watermark: null,
        lag_ms: null,
      });
      expect(result.data.interpretation.caveats).toContain(
        "Event-time completeness is unknown. A fresh status means only a recent projection; producer delivery and event coverage are unverified.",
      );
      expect(result.data.data.stages.find((s: Json) => s.stage_key === "qa.review")).toMatchObject({
        n: 9,
        open_n: 0,
        p50_ms: 3000,
        p90_ms: 3000,
        mean_ms: 3000,
        suppressed: false,
      });
      const timeline = await call(client, "get_case_timeline", {
        app_id: appId,
        case_id: "dotted-case-0",
      });
      expect(timeline.error).toBeNull();
      expect(timeline.data.data.entries.map((e: Json) => e.stage_key)).toEqual([
        "build",
        "qa.review",
        "done",
      ]);
      expect(timeline.data.data.entries[1].dwell_ms).toBe(3000);
      // Valid-looking but unregistered stage evidence must fail, never silently disappear.
      await env.DB.prepare(
        "UPDATE lifecycle_stage_intervals SET stage_key = 'qa.unregistered' WHERE app_id = ? AND stage_key = 'qa.review'",
      )
        .bind(appId)
        .run();
      expect(
        (await call(client, "get_case_timeline", { app_id: appId, case_id: "dotted-case-0" })).error
          .code,
      ).toBe("source_unavailable");
      expect((await call(client, "get_stage_dwell", args)).error.code).toBe("source_unavailable");
    } finally {
      await client.close();
    }
  });
});

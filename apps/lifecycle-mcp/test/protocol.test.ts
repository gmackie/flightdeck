import { describe, expect, it } from "vitest";
import { OBSERVATIONAL_CAVEATS } from "../src/glossary";
import { READ_ONLY } from "../src/server";
import type { LifecycleReadSource } from "../src/source";
import { PLANNED_ROUTES, ReadApiLifecycleSource } from "../src/sources/read-api";
import { syntheticCases } from "../src/sources/synthetic-data";
import { call, connect, ENV, MCP_URL, RELEASE, raw, SUPPORT, serve, userToken } from "./helpers";

const TOOLS = [
  "list_workflow_definitions",
  "get_case_summary",
  "get_case_timeline",
  "get_stage_dwell",
  "get_funnel",
  "compare_workflow_variants",
  "list_bottlenecks",
  "describe_metric",
  "get_data_freshness",
  "get_data_quality",
  "compare_case_mix",
  "build_evidence_pack",
];

/** Every method a source exposes; only these may ever be called. */
const READ_METHODS = Object.keys(PLANNED_ROUTES);

describe("tool surface", () => {
  it("exposes exactly the twelve read-only tools with strict schemas", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(TOOLS);
    for (const tool of tools) {
      expect(tool.annotations).toEqual(READ_ONLY);
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
      expect(tool.outputSchema).toMatchObject({ type: "object", additionalProperties: false });
      expect(tool.name).not.toMatch(
        /create|update|delete|set|write|run|exec|sql|query|export|mutat/,
      );
    }
    const dwell = tools.find((t) => t.name === "get_stage_dwell");
    expect(dwell?.inputSchema.required).toEqual(["app_id", "workflow_key"]);
    expect(Object.keys(dwell?.inputSchema.properties ?? {})).toEqual([
      "app_id",
      "workflow_key",
      "version",
      "from",
      "to",
      "group_by",
      "filters",
    ]);
  });

  it("advertises only tools, resources and prompts: no tasks, logging or subscriptions", async () => {
    const client = await connect();
    expect(client.getServerCapabilities()).toEqual({
      tools: { listChanged: false },
      resources: { listChanged: false },
      prompts: { listChanged: false },
    });
  });
});

describe("unsupported operations", () => {
  it("rejects unknown tools and extra arguments such as SQL", async () => {
    const client = await connect();
    for (const name of ["run_sql", "update_case", "delete_workflow"]) {
      await expect(client.callTool({ name, arguments: {} })).rejects.toThrow(/not found/i);
    }
    const sql = await call(client, "get_stage_dwell", {
      app_id: RELEASE,
      workflow_key: "change-rollout",
      sql: "SELECT * FROM events",
    });
    expect(sql.isError).toBe(true);
  });

  it("refuses completions, tasks, logging and subscriptions on the server side", async () => {
    for (const [method, params] of [
      [
        "completion/complete",
        { ref: { type: "ref/prompt", name: "x" }, argument: { name: "a", value: "" } },
      ],
      ["tasks/list", {}],
      ["tasks/cancel", { taskId: "t1" }],
      ["resources/subscribe", { uri: "lifecycle://glossary/metrics" }],
      ["logging/setLevel", { level: "debug" }],
      ["subscriptions/listen", { notifications: { toolsListChanged: true } }],
    ] as const) {
      const res = await raw(method, params);
      expect(res.body?.error?.code, method).toBe(-32601);
    }
  });

  it("runs a task-augmented call synchronously without creating a task", async () => {
    const res = await raw(
      "tools/call",
      {
        name: "describe_metric",
        arguments: { metric: "stage_dwell" },
        task: { ttl: 60_000 },
      },
      { headers: { "Mcp-Name": "describe_metric" } },
    );
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/taskId/);
  });

  it("rejects the 2025 session protocol and non-POST methods", async () => {
    const token = await userToken();
    const legacy = await serve(
      new Request(MCP_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "Cf-Access-Jwt-Assertion": token,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "x", version: "1" },
          },
        }),
      }),
    );
    expect(legacy.status).toBe(400);
    expect(await legacy.text()).toContain("-32022");
    for (const method of ["GET", "DELETE", "PUT"]) {
      const res = await serve(
        new Request(MCP_URL, { method, headers: { "Cf-Access-Jwt-Assertion": token } }),
      );
      expect(res.status, method).toBe(405);
    }
  });
});

describe("no writes", () => {
  it("calls only read methods of the source across every tool and resource", async () => {
    const called = new Set<string>();
    const target = syntheticCases().find((c) => c.appId === RELEASE);
    const base = (await import("./helpers")).synthetic();
    const spy = new Proxy(base, {
      get(t, prop, receiver) {
        const value = Reflect.get(t, prop, receiver);
        if (typeof value === "function") called.add(String(prop));
        return typeof value === "function" ? value.bind(t) : value;
      },
    }) as LifecycleReadSource;
    const client = await connect({ source: spy });
    const rollout = { app_id: RELEASE, workflow_key: "change-rollout" };
    for (const [name, args] of [
      ["list_workflow_definitions", { app_id: RELEASE }],
      ["get_case_summary", { app_id: RELEASE, case_id: target?.case_id }],
      ["get_case_timeline", { app_id: RELEASE, case_id: target?.case_id }],
      ["get_stage_dwell", rollout],
      ["get_funnel", rollout],
      ["compare_workflow_variants", { ...rollout, baseline_version: 1, candidate_version: 2 }],
      ["list_bottlenecks", rollout],
      ["describe_metric", { metric: "cycle_time" }],
      ["get_data_freshness", { app_id: RELEASE }],
      ["get_data_quality", rollout],
      ["compare_case_mix", { ...rollout, baseline: { version: 1 }, candidate: { version: 2 } }],
      ["build_evidence_pack", { ...rollout, question: "health" }],
    ] as const) {
      const res = await call(client, name, args);
      expect(res.isError, `${name}: ${res.text}`).toBe(false);
    }
    await client.listResources();
    expect([...called].every((name) => READ_METHODS.includes(name))).toBe(true);
    expect(called.size).toBe(READ_METHODS.length);
  });

  it("the read-API adapter fails closed and never sends a request", async () => {
    let fetched = 0;
    const binding = {
      fetch: async () => {
        fetched++;
        return new Response("{}");
      },
      connect: () => {
        throw new Error("unused");
      },
    } as unknown as Fetcher;
    const source = new ReadApiLifecycleSource(binding);
    const client = await connect({ source, env: { ...ENV, LIFECYCLE_MCP_SOURCE: "read-api" } });
    for (const [name, args] of [
      ["list_workflow_definitions", {}],
      ["get_data_freshness", {}],
      ["get_stage_dwell", { workflow_key: "change-rollout" }],
    ] as const) {
      const res = await call(client, name, { app_id: RELEASE, ...args });
      expect(res.error?.code).toBe("source_unavailable");
    }
    expect((await client.listResources()).resources.map((r) => r.uri)).toEqual([
      "lifecycle://glossary/metrics",
      "lifecycle://spec/workflow-definition",
    ]);
    expect(fetched).toBe(0);
    // Every planned upstream call is a GET (or not specified yet).
    for (const route of Object.values(PLANNED_ROUTES)) {
      expect(route).toMatch(/^(GET |not |data_freshness)/);
    }
  });
});

describe("synthetic sample responses", () => {
  it("labels provenance, freshness and the non-causal interpretation", async () => {
    const client = await connect();
    const res = await call(client, "get_stage_dwell", {
      app_id: SUPPORT,
      workflow_key: "support-ticket",
    });
    expect(res.data.provenance).toEqual({
      source: "synthetic",
      synthetic: true,
      source_version: "synthetic-fixtures@1",
      as_of: "2026-10-30T00:05:00.000Z",
      generated_at: "2026-10-30T00:05:00.000Z",
      freshness: { status: "fresh", watermark: "2026-10-30T00:00:00.000Z", lag_ms: 300_000 },
      tool: "get_stage_dwell",
      query: {
        workflow_key: "support-ticket",
        version: 1,
        from: "2026-08-01T00:05:00.000Z",
        to: "2026-10-30T00:05:00.000Z",
        group_by: null,
        filters: {},
      },
    });
    expect(res.data.interpretation.kind).toBe("observed_process_pattern");
    expect(res.data.interpretation.causal).toBe(false);
    expect(res.data.interpretation.caveats[0]).toMatch(/^SYNTHETIC DATA/);
    expect(res.data.interpretation.caveats).toEqual(
      expect.arrayContaining([...OBSERVATIONAL_CAVEATS]),
    );
    const triage = res.data.data.stages.find(
      (s: { stage_key: string }) => s.stage_key === "triage",
    );
    expect(triage).toMatchObject({
      suppressed: false,
      n: expect.any(Number),
      p50_ms: expect.any(Number),
    });
    expect(triage.p90_ms).toBeGreaterThanOrEqual(triage.p50_ms);
  });

  it("compares versions observationally and ranks bottlenecks as associations", async () => {
    const client = await connect();
    const rollout = {
      app_id: RELEASE,
      workflow_key: "change-rollout",
      from: "2026-06-01",
      to: "2026-10-30",
    };
    const cmp = await call(client, "compare_workflow_variants", {
      ...rollout,
      baseline_version: 1,
      candidate_version: 2,
    });
    const { cohorts, comparison } = cmp.data.data;
    expect(cohorts.map((c: { version: number }) => c.version)).toEqual([1, 2]);
    expect(comparison).toMatchObject({
      baseline_version: 1,
      candidate_version: 2,
      comparable: true,
    });
    expect(comparison.reasons.join(" ")).toMatch(/not caused by the version alone/);
    expect(comparison.deltas.median_cycle_ms).toEqual(expect.any(Number));

    const bn = await call(client, "list_bottlenecks", { ...rollout, version: 1 });
    const [top] = bn.data.data.bottlenecks;
    expect(top).toMatchObject({ rank: 1, evidence: "observed_association" });
    // Version 1 review is slow by construction (30h median vs 20h staging soak).
    expect(top.stage_key).toBe("review");
  });

  it("describes metrics and serves definitions with resource links", async () => {
    const client = await connect();
    const metric = await call(client, "describe_metric", { metric: "bottleneck_signal" });
    expect(metric.data.app_id).toBeNull();
    expect(metric.data.data.metric.caveats.join(" ")).toMatch(/Not causal/);
    const defs = await call(client, "list_workflow_definitions", { app_id: RELEASE });
    expect(defs.data.data.definitions.map((d: { version: number }) => d.version)).toEqual([2, 1]);
    expect(defs.data.data.definitions[0].resource_uri).toBe(
      `lifecycle://apps/${RELEASE}/workflows/change-rollout/definition`,
    );
    const fresh = await call(client, "get_data_freshness", { app_id: RELEASE });
    expect(fresh.data.data).toMatchObject({
      status: "fresh",
      watermark: "2026-10-30T00:00:00.000Z",
    });
  });
});

import { describe, expect, it } from "vitest";
import type { Grant, LifecycleReadSource } from "../src/source";
import { PLANNED_ROUTES } from "../src/sources/read-api";
import { call, connect, NOW, RELEASE, RESTRICTED, SUPPORT, synthetic } from "./helpers";

const APP_TOOLS: [string, Record<string, unknown>][] = [
  ["list_workflow_definitions", {}],
  ["get_case_summary", { case_id: "c_x1_000abcdef" }],
  ["get_case_timeline", { case_id: "c_x1_000abcdef" }],
  ["get_stage_dwell", { workflow_key: "support-ticket" }],
  ["get_funnel", { workflow_key: "support-ticket" }],
  ["compare_workflow_variants", { workflow_key: "support-ticket" }],
  ["list_bottlenecks", { workflow_key: "support-ticket" }],
  ["get_data_freshness", {}],
];

/** Records the app of every data call the server makes. */
function recording(inner: LifecycleReadSource) {
  const apps: string[] = [];
  const source = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      const data = prop !== "grantsFor" && Object.hasOwn(PLANNED_ROUTES, prop);
      if (typeof value !== "function" || !data) return value;
      return (scope: { appId: string }, ...rest: unknown[]) => {
        apps.push(scope.appId);
        return value.call(target, scope, ...rest);
      };
    },
  });
  return { source, apps };
}

describe("app-scoped grants", () => {
  it("denies every app tool on an app without a grant, identically to an unknown app", async () => {
    const { source, apps } = recording(synthetic());
    const client = await connect({ source });
    for (const [name, args] of APP_TOOLS) {
      const restricted = await call(client, name, { app_id: RESTRICTED, ...args });
      const unknown = await call(client, name, { app_id: "no-such-app", ...args });
      expect(restricted.error).toEqual({
        code: "forbidden",
        message: "Not authorized for this app, or the app does not exist",
      });
      expect(unknown.error).toEqual(restricted.error);
    }
    // The source was never asked anything about either app.
    expect(apps).toEqual([]);
  });

  it("does not let a cursor from one app page another", async () => {
    const both: Grant[] = [
      { appId: RELEASE, role: "reader", expiresAt: null },
      { appId: SUPPORT, role: "reader", expiresAt: null },
    ];
    const client = await connect({ source: synthetic({ grants: () => both }) });
    const first = await call(client, "list_workflow_definitions", { app_id: RELEASE, limit: 1 });
    const cursor = first.data.page.next_cursor;
    expect(cursor).toEqual(expect.any(String));
    const other = await call(client, "list_workflow_definitions", {
      app_id: SUPPORT,
      limit: 1,
      cursor,
    });
    expect(other.error?.code).toBe("invalid_argument");
  });

  it("limits readers to definitions and single cases; aggregates need analyst", async () => {
    const reader = synthetic({
      grants: () => [{ appId: RELEASE, role: "reader", expiresAt: null }],
    });
    const client = await connect({ source: reader });
    expect((await call(client, "get_data_freshness", { app_id: RELEASE })).isError).toBe(false);
    for (const name of [
      "get_stage_dwell",
      "get_funnel",
      "compare_workflow_variants",
      "list_bottlenecks",
    ]) {
      const res = await call(client, name, { app_id: RELEASE, workflow_key: "change-rollout" });
      expect(res.error?.code).toBe("forbidden");
    }
  });

  it("ignores expired grants and unknown roles", async () => {
    const grants: Grant[] = [
      { appId: RELEASE, role: "analyst", expiresAt: NOW - 1 },
      { appId: SUPPORT, role: "superuser" as Grant["role"], expiresAt: null },
    ];
    const client = await connect({ source: synthetic({ grants: () => grants }) });
    for (const app_id of [RELEASE, SUPPORT]) {
      expect((await call(client, "get_data_freshness", { app_id })).error?.code).toBe("forbidden");
    }
  });

  it("denies everything when grants cannot be loaded", async () => {
    const client = await connect({
      source: synthetic({
        grants: () => {
          throw new Error("policy store down: secret detail");
        },
      }),
    });
    const res = await call(client, "get_data_freshness", { app_id: RELEASE });
    expect(res.error?.code).toBe("source_unavailable");
    expect(res.text).not.toContain("secret detail");
  });

  it("lists and reads definition resources only for granted apps", async () => {
    const client = await connect();
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toEqual(
      expect.arrayContaining([
        "lifecycle://glossary/metrics",
        "lifecycle://spec/workflow-definition",
        `lifecycle://apps/${RELEASE}/workflows/change-rollout/definition`,
        `lifecycle://apps/${SUPPORT}/workflows/support-ticket/definition`,
      ]),
    );
    expect(uris.some((uri) => uri.includes(RESTRICTED))).toBe(false);

    const read = await client.readResource({
      uri: `lifecycle://apps/${RELEASE}/workflows/change-rollout/definition`,
    });
    const body = JSON.parse(String((read.contents[0] as { text: string }).text));
    expect(body).toMatchObject({ app_id: RELEASE, synthetic: true });
    expect(body.definition.version).toBe(2);

    for (const uri of [
      `lifecycle://apps/${RESTRICTED}/workflows/support-ticket/definition`,
      "lifecycle://apps/no-such-app/workflows/support-ticket/definition",
    ]) {
      await expect(client.readResource({ uri })).rejects.toThrow(/not found/i);
    }
  });
});

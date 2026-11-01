import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import type { AccessPrincipal } from "../src/access";
import {
  type LifecycleReadAuthorizer,
  lifecycleServingRoutes,
  type ServingOptions,
} from "../src/lifecycle-serving/routes";
import { DAY, HOUR, MIN, openSnap, prov, repo, seed, snap, T0 } from "./lifecycle-fixtures";

/** Response bodies are asserted structurally, so they are read as loose JSON. */
// biome-ignore lint/suspicious/noExplicitAny: test-only JSON access
type Json = any;

const PRINCIPAL: AccessPrincipal = { sub: "svc-test", serviceToken: true };
const NOW = T0 + DAY + 5 * MIN;
const APP = "app_serving";
const OTHER = "app_serving_other";

/** Grants every capability on every app it is asked about, recording the checks. */
const allowAll = (calls: unknown[] = []): LifecycleReadAuthorizer => {
  return async (check) => {
    calls.push({ appId: check.appId, capability: check.capability });
    return { appId: check.appId };
  };
};

const call = async (
  path: string,
  options: ServingOptions = { authorize: allowAll() },
  init: RequestInit = {},
) => {
  const response = await lifecycleServingRoutes(
    new Request(`https://flightdeck.test${path}`, init),
    env,
    PRINCIPAL,
    { now: () => NOW, ...options },
  );
  if (!response) throw new Error("route not handled");
  return response;
};
const get = async (path: string, options?: ServingOptions) => {
  const res = await call(path, options);
  return { status: res.status, body: (await res.json()) as Record<string, Json> };
};

/** Six closed deploys (dwell 10..60 min in build), one open, one failure, plus a hierarchy. */
beforeAll(async () => {
  const { repo: r } = repo(env.DB);
  const closed = [10, 20, 30, 40, 50, 60].map((m, i) =>
    snap(`d${i}`, {
      started_at: T0 + i * HOUR,
      ended_at: T0 + i * HOUR + (m + 5) * MIN,
      last_event_at: T0 + i * HOUR + (m + 5) * MIN,
      outcome: i === 5 ? "failure" : "success",
      intervals: [
        {
          stage_key: "build",
          state: "active",
          entered_at: T0 + i * HOUR,
          exited_at: T0 + i * HOUR + m * MIN,
        },
        // Only two cases are ever blocked: a group too small to release.
        ...(i < 2
          ? [{ stage_key: "build", state: "blocked" as const, entered_at: T0, exited_at: T0 + MIN }]
          : []),
        {
          stage_key: "release",
          state: "active" as const,
          entered_at: T0 + i * HOUR + m * MIN,
          exited_at: T0 + i * HOUR + (m + 5) * MIN,
        },
      ],
    }),
  );
  await seed(
    r,
    APP,
    [
      ...closed,
      openSnap("d_open", {
        started_at: T0 + 10 * HOUR,
        intervals: [
          { stage_key: "build", state: "active", entered_at: T0 + 10 * HOUR, exited_at: null },
        ],
        relations: [{ relation: "supersedes", to_case_id: "d5" }],
      }),
      snap("parent", { process_key: "release_train", started_at: T0 - DAY, intervals: [] }),
      snap("child_a", {
        process_key: "release_train",
        parent_case_id: "parent",
        started_at: T0 - DAY + 1,
        intervals: [],
      }),
      openSnap("orphan", {
        process_key: "release_train",
        parent_case_id: "not_projected",
        started_at: T0 - 2 * DAY,
        intervals: [],
      }),
      snap("old", { started_at: T0 - 90 * DAY, ended_at: T0 - 89 * DAY, intervals: [] }),
    ],
    { source_watermark: 900, as_of: T0 + DAY },
  );
  // Another app reusing the same case ids must never leak into APP's answers.
  await seed(repo(env.DB).repo, OTHER, [snap("d0", { outcome: "failure" }), snap("secret")]);
});

describe("authorization", () => {
  it("denies by default, before validating the query or reading data", async () => {
    for (const path of [
      `/api/apps/${APP}/lifecycle/cases`,
      `/api/apps/${APP}/lifecycle/cases?bogus=1`,
      `/api/apps/${APP}/lifecycle/cases/d0`,
      `/api/apps/${APP}/lifecycle/summaries/stages`,
    ]) {
      const res = await call(path, {});
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Forbidden" });
    }
  });

  it("asks for process:read on aggregates and lifecycle:read elsewhere", async () => {
    const calls: unknown[] = [];
    await call(`/api/apps/${APP}/lifecycle/processes`, { authorize: allowAll(calls) });
    await call(`/api/apps/${APP}/lifecycle/summaries/outcomes?process_key=deploy&version=1`, {
      authorize: allowAll(calls),
    });
    expect(calls).toEqual([
      { appId: APP, capability: "lifecycle:read" },
      { appId: APP, capability: "process:read" },
    ]);
  });

  it("fails closed when the checker throws or scopes a different app", async () => {
    const throwing: LifecycleReadAuthorizer = async () => {
      throw new Error("grant store down");
    };
    expect((await call(`/api/apps/${APP}/lifecycle/cases`, { authorize: throwing })).status).toBe(
      503,
    );
    const confused: LifecycleReadAuthorizer = async () => ({ appId: OTHER });
    expect((await call(`/api/apps/${APP}/lifecycle/cases`, { authorize: confused })).status).toBe(
      403,
    );
  });

  it("is read-only and ignores paths it does not serve", async () => {
    const res = await call(`/api/apps/${APP}/lifecycle/cases`, undefined, { method: "POST" });
    expect(res.status).toBe(405);
    for (const path of [
      `/api/apps/${APP}/lifecycle/policy`,
      `/api/apps/${APP}/lifecycle/cases/a@b`,
      `/api/apps/${APP}/trends`,
    ]) {
      const handled = await lifecycleServingRoutes(
        new Request(`https://flightdeck.test${path}`),
        env,
        PRINCIPAL,
        { authorize: allowAll() },
      );
      expect(handled).toBeNull();
    }
  });
});

describe("envelope and freshness", () => {
  it("reports as_of, freshness and provenance of the committed projection", async () => {
    const { status, body } = await get(`/api/apps/${APP}/lifecycle/processes`);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      app_id: APP,
      as_of: T0 + DAY,
      data_freshness: {
        status: "fresh",
        projection: "ready",
        lag_ms: 5 * MIN,
        generation: 1,
        source_watermark: 900,
      },
      sample_count: 1,
      suppressed: false,
      page: { limit: 25, next_cursor: null },
    });
    expect(body.data).toEqual([
      expect.objectContaining({ process_key: "deploy", version: 1, label: "Deploy pipeline" }),
    ]);
    expect(body.data[0].stages.map((s: { key: string }) => s.key)).toEqual(["build", "release"]);
  });

  it("marks an old projection stale", async () => {
    const { body } = await get(`/api/apps/${APP}/lifecycle/processes`, {
      authorize: allowAll(),
      now: () => T0 + 3 * DAY,
    });
    expect(body.data_freshness).toMatchObject({ status: "stale", lag_ms: 2 * DAY });
  });

  it("is honest when nothing has been projected for the app", async () => {
    const { status, body } = await get("/api/apps/app_never_projected/lifecycle/cases");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      as_of: null,
      data_freshness: { status: "unavailable", projection: "none", generation: null },
      sample_count: 0,
      data: [],
    });
  });
});

describe("case lists", () => {
  const casesOf = async (query: string, app = APP) => {
    const { status, body } = await get(`/api/apps/${app}/lifecycle/cases?${query}`);
    expect(status).toBe(200);
    return body.data.map((c: { case_id: string }) => c.case_id);
  };

  it("pages newest first with a stable keyset cursor", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = `process_key=deploy&limit=3${cursor ? `&cursor=${cursor}` : ""}`;
      const { body } = await get(`/api/apps/${APP}/lifecycle/cases?${query}`);
      expect(body.data.length).toBeLessThanOrEqual(3);
      seen.push(...body.data.map((c: { case_id: string }) => c.case_id));
      cursor = body.page.next_cursor;
      pages++;
    } while (cursor && pages < 10);
    expect(seen).toEqual(["d_open", "d5", "d4", "d3", "d2", "d1", "d0", "old"]);
    expect(pages).toBe(3);
  });

  it("rejects cursors reused with other filters, tampered or oversized", async () => {
    const { body } = await get(`/api/apps/${APP}/lifecycle/cases?process_key=deploy&limit=2`);
    const cursor = body.page.next_cursor;
    for (const query of [
      `process_key=deploy&status=open&limit=2&cursor=${cursor}`,
      `process_key=deploy&limit=2&cursor=${cursor}x`,
      `cursor=${"A".repeat(600)}`,
    ]) {
      expect((await get(`/api/apps/${APP}/lifecycle/cases?${query}`)).status).toBe(400);
    }
    // The same cursor against another app is refused rather than reinterpreted.
    expect(
      (await get(`/api/apps/${OTHER}/lifecycle/cases?process_key=deploy&limit=2&cursor=${cursor}`))
        .status,
    ).toBe(400);
  });

  it("filters by status, outcome, stage and start dates", async () => {
    expect(await casesOf("status=open")).toEqual(["d_open", "orphan"]);
    expect(await casesOf("process_key=deploy&outcome=failure")).toEqual(["d5"]);
    expect(await casesOf("stage=build")).toEqual(["d_open", "orphan"]);
    const after = new Date(T0 + 2 * HOUR).toISOString();
    const before = new Date(T0 + 4 * HOUR).toISOString();
    expect(await casesOf(`started_after=${after}&started_before=${before}`)).toEqual(["d3", "d2"]);
    expect(await casesOf("process_key=deploy&started_before=2026-09-01")).toEqual(["old"]);
    expect(await casesOf("process_key=deploy&version=2")).toEqual([]);
  });

  it("filters children of a parent", async () => {
    expect(await casesOf("parent=parent")).toEqual(["child_a"]);
  });

  it("rejects unsupported, repeated and malformed filters", async () => {
    for (const query of [
      "app_id=app_serving_other",
      "email=x",
      "status=open&status=closed",
      "status=pending",
      "limit=0",
      "limit=101",
      "version=1",
      "process_key=Deploy",
      "parent=a@b",
      "started_after=yesterday",
      "started_after=2026-10-02&started_before=2026-10-01",
    ]) {
      const { status, body } = await get(`/api/apps/${APP}/lifecycle/cases?${query}`);
      expect(status, query).toBe(400);
      expect(body.error).toBeTypeOf("string");
    }
  });

  it("never returns another app's cases", async () => {
    expect(await casesOf("", OTHER)).toEqual(["secret", "d0"]);
    expect(await casesOf("")).not.toContain("secret");
  });
});

describe("case detail", () => {
  it("returns intervals, relations and provenance", async () => {
    const { status, body } = await get(`/api/apps/${APP}/lifecycle/cases/d_open`);
    expect(status).toBe(200);
    expect(body.sample_count).toBe(1);
    expect(body.data).toMatchObject({
      case_id: "d_open",
      status: "open",
      ended_at: null,
      provenance: {
        generation: 1,
        source_watermark: 900,
        reducer_version: "lifecycle@1",
        as_of: T0,
      },
      intervals: [{ stage_key: "build", state: "active", exited_at: null }],
      parent: null,
      relations: { outgoing: [{ relation: "supersedes", case_id: "d5" }] },
    });
    const target = await get(`/api/apps/${APP}/lifecycle/cases/d5`);
    expect(target.body.data.relations.incoming).toEqual({
      items: [{ relation: "supersedes", case_id: "d_open" }],
      truncated: false,
    });
  });

  it("links parents and children, flagging parents not projected yet", async () => {
    const parent = await get(`/api/apps/${APP}/lifecycle/cases/parent`);
    expect(parent.body.data.children).toMatchObject({
      items: [{ case_id: "child_a" }],
      truncated: false,
    });
    const child = await get(`/api/apps/${APP}/lifecycle/cases/child_a`);
    expect(child.body.data.parent).toMatchObject({ case_id: "parent", available: true });
    const orphan = await get(`/api/apps/${APP}/lifecycle/cases/orphan`);
    expect(orphan.body.data.parent).toEqual({
      case_id: "not_projected",
      available: false,
      summary: null,
    });
  });

  it("answers 404 alike for another app's case and a missing one", async () => {
    const leaked = await get(`/api/apps/${APP}/lifecycle/cases/secret`);
    const missing = await get(`/api/apps/${APP}/lifecycle/cases/nope`);
    expect(leaked).toEqual(missing);
    expect(leaked.status).toBe(404);
    expect((await get(`/api/apps/${APP}/lifecycle/cases/d0?x=1`)).status).toBe(400);
  });
});

describe("aggregates", () => {
  const WINDOW = `started_after=${new Date(T0).toISOString()}&started_before=${new Date(T0 + DAY).toISOString()}`;

  it("summarizes dwell per stage, censoring open intervals and withholding small groups", async () => {
    const { status, body } = await get(
      `/api/apps/${APP}/lifecycle/summaries/stages?process_key=deploy&version=1&${WINDOW}`,
    );
    expect(status).toBe(200);
    expect(body.cohort).toMatchObject({ process_key: "deploy", version: 1, min_cohort: 5 });
    const build = body.data.find((g: Json) => g.stage_key === "build" && g.state === "active");
    expect(build).toEqual({
      stage_key: "build",
      state: "active",
      case_count: 7,
      closed_intervals: 6,
      open_intervals: 1,
      dwell_ms: { mean: 35 * MIN, p50: 30 * MIN, p90: 60 * MIN, min: 10 * MIN, max: 60 * MIN },
    });
    expect(body.data.find((g: Json) => g.stage_key === "release")).toMatchObject({
      case_count: 6,
      dwell_ms: { p50: 5 * MIN },
    });
    // build/blocked covers only two cases.
    expect(body.data.some((g: Json) => g.state === "blocked")).toBe(false);
    expect(body.suppressed).toBe(true);
    expect(body.sample_count).toBe(7);
  });

  it("summarizes outcomes, releasing only groups at or above the minimum cohort", async () => {
    const { body } = await get(
      `/api/apps/${APP}/lifecycle/summaries/outcomes?process_key=deploy&version=1&${WINDOW}`,
    );
    expect(body.data).toEqual([
      {
        status: "closed",
        outcome: "success",
        case_count: 5,
        duration_ms: { mean: 35 * MIN, p50: 35 * MIN, p90: 55 * MIN },
      },
    ]);
    expect(body).toMatchObject({ sample_count: 5, suppressed: true });

    const lowered = await get(
      `/api/apps/${APP}/lifecycle/summaries/outcomes?process_key=deploy&version=1&${WINDOW}`,
      { authorize: allowAll(), minCohort: 1 },
    );
    // The floor is two, so a single failure or open case is still withheld.
    expect(lowered.body.cohort.min_cohort).toBe(2);
    expect(lowered.body.data).toHaveLength(1);
  });

  it("filters the cohort by status and window", async () => {
    const open = await get(
      `/api/apps/${APP}/lifecycle/summaries/stages?process_key=deploy&version=1&status=open&${WINDOW}`,
      { authorize: allowAll(), minCohort: 2 },
    );
    expect(open.body).toMatchObject({ data: [], sample_count: 0, suppressed: true });
    // The default window is the 30 days before now, which excludes the 90-day-old case.
    const recent = await get(
      `/api/apps/${APP}/lifecycle/summaries/outcomes?process_key=deploy&version=1`,
    );
    expect(recent.body.cohort.started_before).toBe(new Date(NOW).toISOString());
    expect(recent.body.sample_count).toBe(5);
  });

  it("requires one process version and a bounded window", async () => {
    for (const query of [
      "",
      "process_key=deploy",
      "version=1",
      "process_key=deploy&version=1&started_after=2025-01-01&started_before=2026-10-01",
      "process_key=deploy&version=1&outcome=success",
      "process_key=deploy&version=1&limit=5",
    ]) {
      expect(
        (await get(`/api/apps/${APP}/lifecycle/summaries/stages?${query}`)).status,
        query,
      ).toBe(400);
    }
  });

  it("drops soft-deleted cases from lists and aggregates", async () => {
    const app = "app_serving_deleted";
    const { repo: r } = repo(env.DB);
    await seed(
      r,
      app,
      [0, 1, 2, 3, 4].map((i) => snap(`c${i}`, { started_at: T0 + i })),
    );
    const path = `/api/apps/${app}/lifecycle/summaries/outcomes?process_key=deploy&version=1&${WINDOW}`;
    expect((await get(path)).body.sample_count).toBe(5);
    await r.tombstoneCase(app, "c0", prov(1, 200));
    const after = await get(path);
    expect(after.body).toMatchObject({ data: [], sample_count: 0, suppressed: true });
    const list = await get(`/api/apps/${app}/lifecycle/cases`);
    expect(list.body.data.map((c: { case_id: string }) => c.case_id)).toEqual([
      "c4",
      "c3",
      "c2",
      "c1",
    ]);
  });
});

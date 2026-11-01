import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { SnapshotRejected } from "../src/lifecycle-serving/model";
import { caseDetail, listCases } from "../src/lifecycle-serving/read";
import { DAY, HOUR, openSnap, prov, repo, seed, snap, T0 } from "./lifecycle-fixtures";

const ALL = {
  processKey: null,
  version: null,
  status: null,
  outcome: null,
  stage: null,
  parent: null,
  startedAfter: null,
  startedBefore: null,
};
const ids = async (appId: string) =>
  (await listCases(env.DB, appId, ALL, { limit: 100, after: null })).map((c) => c.case_id);
const raw = (appId: string, caseId: string) =>
  env.DB.prepare("SELECT * FROM lifecycle_case_snapshots WHERE app_id = ? AND case_id = ?")
    .bind(appId, caseId)
    .first<Record<string, unknown>>();
const intervalCount = async (appId: string, caseId: string) =>
  (
    await env.DB.prepare(
      "SELECT count(*) AS n FROM lifecycle_stage_intervals WHERE app_id = ? AND case_id = ?",
    )
      .bind(appId, caseId)
      .first<{ n: number }>()
  )?.n;
const rejection = async (p: Promise<unknown>) => {
  const error = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(SnapshotRejected);
  return error as SnapshotRejected;
};

describe("generations", () => {
  it("commits a rebuild and records its watermark and row count", async () => {
    const { repo: r } = repo(env.DB);
    const gen = await seed(r, "app_gen_commit", [snap("c1"), openSnap("c2")]);
    expect(gen).toBe(1);
    const state = await r.state("app_gen_commit");
    expect(state).toMatchObject({
      active_generation: 1,
      building_generation: null,
      issued_generation: 1,
      status: "ready",
      source_watermark: 100,
      as_of: T0 + DAY,
      reducer_version: "lifecycle@1",
      rows_written: 2,
    });
  });

  it("rejects writes for a generation that is neither active nor building", async () => {
    const { repo: r } = repo(env.DB);
    expect((await rejection(r.upsertCase("app_gen_none", snap("c1"), prov(1, 1)))).reason).toBe(
      "generation",
    );
    await seed(r, "app_gen_closed", [snap("c1")]);
    const err = await rejection(r.upsertCase("app_gen_closed", snap("c2"), prov(7, 1)));
    expect(err.reason).toBe("generation");
    expect(await ids("app_gen_closed")).toEqual(["c1"]);
  });

  it("soft-deletes rows a rebuild did not rewrite, and the rebuild wins over late writes", async () => {
    const app = "app_gen_rebuild";
    const { repo: r } = repo(env.DB);
    await seed(r, app, [snap("keep"), snap("gone", { started_at: T0 + 1 })]);
    const gen = await r.beginRebuild(app);
    expect(gen).toBe(2);
    expect(await r.upsertCase(app, snap("keep", { outcome: "rolled_back" }), prov(gen, 50))).toBe(
      "written",
    );
    // An incremental write for the old generation arrives after the rebuild rewrote the row.
    expect(await r.upsertCase(app, snap("keep"), prov(1, 500))).toBe("stale");
    // Readers keep seeing the old generation's other rows until commit.
    expect(await ids(app)).toEqual(["gone", "keep"]);
    const result = await r.commitRebuild(app, prov(gen, 50));
    expect(result).toEqual({ superseded_cases: 1, superseded_definitions: 1 });
    expect(await ids(app)).toEqual(["keep"]);
    expect(await raw(app, "gone")).toMatchObject({ deleted_reason: "superseded" });
    expect(await raw(app, "keep")).toMatchObject({ generation: 2, outcome: "rolled_back" });
    // Committing the same generation again is refused.
    expect((await rejection(r.commitRebuild(app, prov(gen, 50)))).reason).toBe("generation");
  });

  it("records a failed rebuild without touching the active generation", async () => {
    const app = "app_gen_fail";
    const { repo: r } = repo(env.DB);
    await seed(r, app, [snap("c1")]);
    const failed = await r.beginRebuild(app);
    await r.failRebuild(app, failed, "source_timeout");
    expect(await r.state(app)).toMatchObject({
      status: "failed",
      active_generation: 1,
      building_generation: null,
      last_error_code: "source_timeout",
    });
    expect((await rejection(r.upsertCase(app, snap("c2"), prov(failed, 1)))).reason).toBe(
      "generation",
    );
    // Failed generation numbers are never reissued.
    expect(await r.beginRebuild(app)).toBe(failed + 1);
    expect(await ids(app)).toEqual(["c1"]);
  });

  it("only moves the watermark forward", async () => {
    const app = "app_gen_mark";
    const { repo: r } = repo(env.DB);
    await seed(r, app, []);
    expect(await r.advanceWatermark(app, { source_watermark: 150, as_of: T0 + 2 * DAY })).toBe(
      true,
    );
    expect(await r.advanceWatermark(app, { source_watermark: 120, as_of: T0 + 3 * DAY })).toBe(
      false,
    );
    expect(await r.state(app)).toMatchObject({ source_watermark: 150, as_of: T0 + 2 * DAY });
  });
});

describe("idempotent upserts", () => {
  it("replays the same snapshot without duplicating children", async () => {
    const app = "app_idem";
    const { repo: r } = repo(env.DB);
    await seed(r, app, []);
    const c = snap("c1", { relations: [{ relation: "follows", to_case_id: "c0" }] });
    expect(await r.upsertCase(app, c, prov(1, 200))).toBe("written");
    expect(await r.upsertCase(app, c, prov(1, 200))).toBe("written");
    expect(await intervalCount(app, "c1")).toBe(2);
    const edges = await env.DB.prepare(
      "SELECT count(*) AS n FROM lifecycle_case_edges WHERE app_id = ?",
    )
      .bind(app)
      .first<{ n: number }>();
    expect(edges?.n).toBe(1);
  });

  it("ignores an older watermark, including its intervals", async () => {
    const app = "app_stale_write";
    const { repo: r } = repo(env.DB);
    await seed(r, app, []);
    await r.upsertCase(app, openSnap("c1"), prov(1, 300));
    const older = snap("c1");
    expect(await r.upsertCase(app, older, prov(1, 299))).toBe("stale");
    expect(await raw(app, "c1")).toMatchObject({ status: "open", source_watermark: 300 });
    expect(await intervalCount(app, "c1")).toBe(1);
  });

  it("replaces intervals and relations wholesale on a newer snapshot", async () => {
    const app = "app_replace";
    const { repo: r } = repo(env.DB);
    await seed(r, app, [snap("x"), snap("y"), openSnap("c1")]);
    await r.upsertCase(
      app,
      openSnap("c1", { relations: [{ relation: "blocks", to_case_id: "x" }] }),
      prov(1, 101),
    );
    const many = Array.from({ length: 23 }, (_, i) => ({
      stage_key: "build",
      state: "active" as const,
      entered_at: T0 + i,
      exited_at: T0 + i + 1,
    }));
    await r.upsertCase(
      app,
      snap("c1", { intervals: many, relations: [{ relation: "blocks", to_case_id: "y" }] }),
      prov(1, 102),
    );
    expect(await intervalCount(app, "c1")).toBe(23);
    const detail = await caseDetail(env.DB, app, "c1");
    expect(detail?.relations.outgoing).toEqual([{ relation: "blocks", case_id: "y" }]);
    expect(detail?.intervals.at(-1)).toMatchObject({ entered_at: T0 + 22 });
  });
});

describe("validation", () => {
  it("refuses non-opaque ids and inconsistent snapshots without echoing values", async () => {
    const app = "app_invalid";
    const { repo: r } = repo(env.DB);
    await seed(r, app, []);
    const email = await rejection(r.upsertCase(app, snap("someone@example.com"), prov(1, 1)));
    expect(email.reason).toBe("invalid");
    expect(email.message).not.toContain("example.com");
    for (const bad of [
      snap("c1", { status: "open" }),
      snap("c1", { ended_at: T0 - 1 }),
      snap("c1", { parent_case_id: "c1" }),
      openSnap("c1", { status: "closed", ended_at: T0 + 1 }),
      snap("c1", { process_key: "Deploy Pipeline" }),
      { ...snap("c1"), note: "free text" } as never,
    ]) {
      expect((await rejection(r.upsertCase(app, bad, prov(1, 1)))).reason).toBe("invalid");
    }
    expect(await ids(app)).toEqual([]);
  });
});

describe("hierarchy", () => {
  it("reparents a child and refuses cycles", async () => {
    const app = "app_reparent";
    const { repo: r } = repo(env.DB);
    await seed(r, app, [snap("a"), snap("b"), snap("child", { parent_case_id: "a" })]);
    expect((await caseDetail(env.DB, app, "a"))?.children.items.map((c) => c.case_id)).toEqual([
      "child",
    ]);
    await r.upsertCase(app, snap("child", { parent_case_id: "b" }), prov(1, 101));
    expect((await caseDetail(env.DB, app, "a"))?.children.items).toEqual([]);
    expect((await caseDetail(env.DB, app, "b"))?.children.items.map((c) => c.case_id)).toEqual([
      "child",
    ]);
    // b -> child would make child its own ancestor.
    const cycle = await rejection(
      r.upsertCase(app, snap("b", { parent_case_id: "child" }), prov(1, 102)),
    );
    expect(cycle.reason).toBe("cycle");
    expect(await raw(app, "b")).toMatchObject({ parent_case_id: null });
  });
});

describe("deletion and retention", () => {
  it("tombstones a case so older replays cannot resurrect it", async () => {
    const app = "app_tombstone";
    const { repo: r } = repo(env.DB);
    await seed(r, app, [snap("c1")]);
    expect(await r.tombstoneCase(app, "c1", prov(1, 200))).toBe("written");
    expect(await ids(app)).toEqual([]);
    expect(await r.upsertCase(app, snap("c1"), prov(1, 150))).toBe("stale");
    expect(await ids(app)).toEqual([]);
    expect(await r.upsertCase(app, snap("c1"), prov(1, 201))).toBe("written");
    expect(await ids(app)).toEqual(["c1"]);
  });

  it("retires closed cases past retention, keeps open ones, then purges", async () => {
    const app = "app_retention";
    const { repo: r, clock } = repo(env.DB);
    await seed(r, app, [
      snap("old", { started_at: T0 - 100 * DAY, ended_at: T0 - 99 * DAY }),
      openSnap("old_open", { started_at: T0 - 100 * DAY }),
      snap("recent"),
    ]);
    expect(await r.applyRetention(app, T0 - 30 * DAY)).toBe(1);
    expect(await ids(app)).toEqual(["recent", "old_open"]);
    expect(await raw(app, "old")).toMatchObject({ deleted_reason: "retention" });
    expect(await intervalCount(app, "old")).toBe(2);

    // Purge removes only rows soft-deleted before the cutoff.
    expect(await r.purgeDeleted(app, clock.now)).toEqual({ cases: 0 });
    clock.now += HOUR;
    expect(await r.purgeDeleted(app, clock.now)).toEqual({ cases: 1 });
    expect(await raw(app, "old")).toBeNull();
    expect(await intervalCount(app, "old")).toBe(0);
    expect(await r.diagnostics(app)).toMatchObject({ cases: { live: 2, deleted: 0 } });
  });

  it("drops an app's derived rows for a clean rebuild", async () => {
    const app = "app_drop";
    const { repo: r } = repo(env.DB);
    await seed(r, app, [snap("c1")]);
    await r.dropApp(app);
    expect(await r.state(app)).toBeNull();
    expect(await ids(app)).toEqual([]);
    expect(await intervalCount(app, "c1")).toBe(0);
    expect(await seed(r, app, [snap("c1")])).toBe(1);
  });
});

describe("app isolation", () => {
  it("keeps the same case id independent per app", async () => {
    const { repo: r } = repo(env.DB);
    await seed(r, "app_iso_one", [snap("shared", { outcome: "success" })]);
    await seed(r, "app_iso_two", [snap("shared", { outcome: "failure" })]);
    await r.tombstoneCase("app_iso_one", "shared", prov(1, 200));
    expect(await ids("app_iso_one")).toEqual([]);
    expect((await caseDetail(env.DB, "app_iso_two", "shared"))?.outcome).toBe("failure");
    // A generation open in one app is not open in another.
    await r.beginRebuild("app_iso_two");
    expect((await rejection(r.upsertCase("app_iso_one", snap("x"), prov(2, 1)))).reason).toBe(
      "generation",
    );
  });
});

describe("replay queue", () => {
  it("dedupes queued requests and tracks attempts and failures", async () => {
    const app = "app_replay";
    const { repo: r } = repo(env.DB);
    const first = await r.requestReplay(app, { reason: "reducer_upgrade", from_watermark: 0 });
    expect(first.created).toBe(true);
    expect(await r.requestReplay(app, { reason: "manual" })).toEqual({
      request_id: first.request_id,
      created: false,
    });
    const claimed = await r.claimReplay(app);
    expect(claimed).toMatchObject({ request_id: first.request_id, status: "running", attempts: 1 });
    expect(await r.claimReplay(app)).toBeNull();
    await r.finishReplay(app, first.request_id, "source_unavailable");
    expect((await r.requestReplay(app, { reason: "retry" })).created).toBe(true);
    expect((await r.diagnostics(app)).replays).toEqual({ failed: 1, queued: 1 });
    await expect(r.requestReplay(app, { reason: "Free text reason" })).rejects.toThrow(
      SnapshotRejected,
    );
  });
});

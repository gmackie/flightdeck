import { env } from "cloudflare:workers";
import { ReadDwell, readSourced } from "@flightdeckhq/schema";
import * as v from "valibot";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessPrincipal } from "../src/access";
import { authorizeLifecycleRead } from "../src/api/authorization";
import { executeRead } from "../src/lifecycle-mcp/read";
import {
  COST,
  canonicalWeek,
  DAY,
  finishReservation,
  reserveAggregate,
  WEEK,
} from "../src/lifecycle-privacy/guard";
import { decodeCursor, encodeCursor } from "../src/lifecycle-serving/params";
import { LifecycleSnapshotRepository } from "../src/lifecycle-serving/repository";
import { snap } from "./lifecycle-fixtures";
import { approveAggregate, budgets } from "./support/privacy";

const APP = "app_privacy";
const OTHER = "app_privacy_other";
const q = {
  method: "getStageDwell" as const,
  workflowKey: "delivery.deploy",
  version: 1,
  from: Date.parse("2026-03-09"),
  to: Date.parse("2026-03-16"),
  groupBy: null,
  filters: {},
};
const p: AccessPrincipal = { sub: "synthetic-person@example.test", serviceToken: false };
const config = {
  ...env,
  ACCESS_TEAM_DOMAIN: "team",
  ACCESS_AUD: "aud",
  LIFECYCLE_PRIVACY_MODE: "enforce",
  LIFECYCLE_PRIVACY_RESTRICTED: "deny",
  LIFECYCLE_PRIVACY_KEY: "synthetic-only-stable-key-32-characters",
};
async function admission(app = APP, subject = p) {
  return reserveAggregate(config, subject, app, q);
}
async function count(table = "lifecycle_privacy_ledger") {
  return (await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())?.n;
}

beforeEach(async () => {
  await env.DB.exec(`DELETE FROM lifecycle_privacy_ledger; DELETE FROM lifecycle_privacy_audit;
    DELETE FROM lifecycle_privacy_limits; DELETE FROM lifecycle_privacy_processes;`);
  for (const app of [APP, OTHER]) {
    await env.DB.prepare("INSERT OR IGNORE INTO apps (id, name) VALUES (?, 'Synthetic')")
      .bind(app)
      .run();
    const definition = {
      schemaVersion: 1,
      processId: q.workflowKey,
      version: 1,
      name: "Synthetic",
      caseType: "deploy",
      stages: [{ stageId: "build", name: "Build" }],
    };
    await env.DB.prepare(`INSERT OR IGNORE INTO process_definitions
      (app_id, process_id, version, definition) VALUES (?, ?, 1, ?)`)
      .bind(app, q.workflowKey, JSON.stringify(definition))
      .run();
    for (const sub of [
      p.sub,
      "another-person",
      ...Array.from({ length: 16 }, (_, i) => `concurrent-${i}`),
    ])
      await env.DB.prepare(`INSERT OR IGNORE INTO authz_grants
        (id, principal_kind, principal_subject, app_id, role) VALUES (?, 'person', ?, ?, 'analyst')`)
        .bind(`privacy-${app}-${sub}`, sub, app)
        .run();
    await approveAggregate(app, q.workflowKey);
    await budgets(app);
  }
});

async function cohort(n: number, visits = 1) {
  const repo = new LifecycleSnapshotRepository(env.DB);
  const generation = await repo.beginRebuild(APP);
  const provenance = {
    generation,
    source_watermark: 17,
    as_of: Date.now(),
    reducer_version: "lifecycle@1",
  };
  await repo.upsertProcessDefinition(
    APP,
    {
      process_key: q.workflowKey,
      version: 1,
      label: "Synthetic",
      stages: [{ key: "build", label: "Build" }],
    },
    provenance,
  );
  for (let i = 0; i < n; i++)
    await repo.upsertCase(
      APP,
      snap(`c${i}`, {
        process_key: q.workflowKey,
        current_stage: "build",
        started_at: q.from + i,
        ended_at: q.from + 1000,
        last_event_at: q.from + 1000,
        intervals: Array.from({ length: visits }, (_, j) => ({
          stage_key: "build",
          state: "active" as const,
          entered_at: q.from + j,
          exited_at: q.from + j + 100,
        })),
      }),
      provenance,
    );
  await repo.commitRebuild(APP, provenance);
}
async function checkAccess() {
  if ((await authorizeLifecycleRead(config, p, APP, "process:read")) instanceof Response)
    throw new Error("Read unavailable");
}
async function dwell() {
  const r = await admission();
  return v.parse(readSourced(v.array(ReadDwell)), await executeRead(env.DB, APP, q, r, checkAccess))
    .data;
}

describe("D1 aggregate admission, migrated under Miniflare", () => {
  it("accepts adjacent disjoint weeks but rejects differencing windows, unions and future cohorts", async () => {
    expect(canonicalWeek(q.from, q.to, Date.now())).toBe(true);
    expect(canonicalWeek(q.from + WEEK, q.to + WEEK, Date.now())).toBe(true);
    for (const [from, to] of [
      [q.from + 1, q.to],
      [q.from, q.to - 1],
      [q.from + DAY, q.to + DAY],
      [q.from, q.to + WEEK],
      [q.from, q.from],
      [q.from, q.to + 100 * WEEK],
      [Number.NaN, q.to],
    ] as const) {
      await expect(reserveAggregate(config, p, APP, { ...q, from, to })).rejects.toThrow();
    }
    expect(canonicalWeek(q.from, q.to, q.to - 1)).toBe(false);
    expect(await count()).toBe(0);
  });
  it("counts every repeat; aliases/grouping/filters/variants cannot get free cohort evidence", async () => {
    await budgets(APP, 2);
    const first = await admission();
    const second = await admission();
    expect(first.fingerprint).toBe(second.fingerprint);
    await expect(admission()).rejects.toThrow();
    for (const query of [
      { ...q, groupBy: "region" },
      { ...q, filters: { region: "eu" } },
      { ...q, method: "getFunnel" as const, stages: ["build"] },
      { ...q, method: "getVariantStats" as const, limit: 1 },
    ])
      await expect(reserveAggregate(config, p, APP, query)).rejects.toThrow();
    expect(await count()).toBe(2);
  });
  it("shares app budget across people, isolates apps, and shares principal ceiling across apps", async () => {
    await budgets(APP, 1, 2);
    await admission();
    await expect(admission(APP, { ...p, sub: "another-person" })).rejects.toThrow();
    await admission(OTHER);
    await expect(admission(OTHER)).rejects.toThrow();
    await admission(OTHER, { ...p, sub: "another-person" });
    expect(await count()).toBe(3);
  });
  it("atomically admits exactly the remaining slots under concurrent requests", async () => {
    await budgets(APP, 3, 100);
    const results = await Promise.allSettled(
      Array.from({ length: 16 }, (_, i) => admission(APP, { ...p, sub: `concurrent-${i}` })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(await count()).toBe(3);
    // Repeat the concurrency check across apps for one principal.
    await env.DB.exec("DELETE FROM lifecycle_privacy_ledger");
    await budgets(APP, 100, 2);
    const global = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) => admission(i % 2 ? APP : OTHER)),
    );
    expect(global.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(await count()).toBe(2);
  });
  it("fails closed for absent/disabled/unknown config, missing limits and missing migrations", async () => {
    for (const overrides of [
      { LIFECYCLE_PRIVACY_MODE: undefined },
      { LIFECYCLE_PRIVACY_MODE: "disabled" },
      { LIFECYCLE_PRIVACY_MODE: "typo" },
      { LIFECYCLE_PRIVACY_KEY: "" },
    ])
      await expect(
        reserveAggregate({ ...config, ...overrides } as Env, p, APP, q),
      ).rejects.toThrow();
    await env.DB.exec("DELETE FROM lifecycle_privacy_limits");
    await expect(admission()).rejects.toThrow();
    expect(await count()).toBe(0);
    const broken = {
      ...config,
      DB: {
        prepare() {
          throw new Error("synthetic private input");
        },
      },
    } as unknown as Env;
    await expect(reserveAggregate(broken, p, APP, q)).rejects.toThrow();
  });
  it("requires exact registered version digest and an operator-only restricted review gate", async () => {
    await approveAggregate(APP, q.workflowKey, "restricted");
    await expect(admission()).rejects.toThrow();
    await expect(
      reserveAggregate({ ...config, LIFECYCLE_PRIVACY_RESTRICTED: "reviewed" }, p, APP, q),
    ).rejects.toThrow();
    await env.DB.prepare(
      "UPDATE lifecycle_privacy_processes SET restricted_approved = 1 WHERE app_id = ?",
    )
      .bind(APP)
      .run();
    await reserveAggregate({ ...config, LIFECYCLE_PRIVACY_RESTRICTED: "reviewed" }, p, APP, q);
    await expect(reserveAggregate(config, p, APP, { ...q, version: 2 })).rejects.toThrow();
    await env.DB.prepare(
      "UPDATE lifecycle_privacy_processes SET definition_hash = ? WHERE app_id = ?",
    )
      .bind("0".repeat(64), APP)
      .run();
    await expect(admission()).rejects.toThrow();
  });
  it("denies before executing for each exhausted resource reservation; retains failures/overruns", async () => {
    for (const [column, amount] of [
      ["row_budget", COST.rows],
      ["scan_budget", COST.scans],
      ["time_budget_ms", COST.time_ms],
    ] as const) {
      await env.DB.exec("DELETE FROM lifecycle_privacy_ledger");
      await budgets(APP);
      await env.DB.prepare(
        `UPDATE lifecycle_privacy_limits SET ${column} = ? WHERE kind = 'app' AND scope = ?`,
      )
        .bind(amount - 1, APP)
        .run();
      await expect(admission()).rejects.toThrow();
      expect(await count()).toBe(0);
    }
    await budgets(APP);
    const r = await admission();
    await expect(
      finishReservation(env.DB, r, { rows: 1, scans: COST.scans + 1, time_ms: 1 }),
    ).rejects.toThrow();
    expect(
      await env.DB.prepare("SELECT scans, rows FROM lifecycle_privacy_ledger WHERE id = ?")
        .bind(r.id)
        .first(),
    ).toMatchObject({ scans: COST.scans + 1, rows: COST.rows });
    await expect(executeRead(env.DB, APP, q)).rejects.toThrow();
    expect(await count()).toBe(1);
  });
  it("keeps raw identities, input fields, results and secrets out of logs and audit", async () => {
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    try {
      await admission();
      await expect(
        reserveAggregate(config, p, APP, { ...q, filters: { notes: "secret" } }),
      ).rejects.toThrow();
      const audit = (await env.DB.prepare("SELECT * FROM lifecycle_privacy_audit").all()).results;
      for (const row of audit) {
        expect(Object.keys(row).sort()).toEqual(["app", "decision", "fingerprint", "principal"]);
        for (const field of ["app", "fingerprint", "principal"])
          expect(row[field]).toMatch(/^[0-9a-f]{64}$/);
      }
      const output = JSON.stringify([audit, logs.map((l) => l.mock.calls)]);
      for (const secret of [
        p.sub,
        APP,
        q.workflowKey,
        "notes",
        "secret",
        config.LIFECYCLE_PRIVACY_KEY,
      ])
        expect(output).not.toContain(secret);
      for (const l of logs) expect(l).not.toHaveBeenCalled();
    } finally {
      for (const l of logs) l.mockRestore();
    }
  });
  it("validates pagination tuple integers and denies services at admission", async () => {
    for (const n of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      const cursor = encodeCursor("test", [n]);
      expect(() => decodeCursor(new URLSearchParams({ cursor }), "test", ["number"])).toThrow();
    }
    await expect(admission(APP, { ...p, serviceToken: true })).rejects.toThrow();
    expect(await count()).toBe(0);
  });
  it("requires actual current role and immediately observes grant revocation", async () => {
    await env.DB.prepare("DELETE FROM authz_grants WHERE principal_subject = ?").bind(p.sub).run();
    await env.DB.prepare(`INSERT INTO authz_grants (id, principal_kind, principal_subject, app_id, role)
      VALUES ('privacy-role', 'person', ?, ?, 'reader')`)
      .bind(p.sub, APP)
      .run();
    expect(await authorizeLifecycleRead(config, p, APP, "process:read")).toBeInstanceOf(Response);
    await expect(admission()).rejects.toThrow();
    expect(await count()).toBe(0);
    await env.DB.exec("UPDATE authz_grants SET role = 'analyst' WHERE id = 'privacy-role'");
    expect(await authorizeLifecycleRead(config, p, APP, "process:read")).toMatchObject({
      appId: APP,
    });
    await env.DB.exec("UPDATE authz_grants SET revoked_at = 1 WHERE id = 'privacy-role'");
    expect(await authorizeLifecycleRead(config, p, APP, "process:read")).toBeInstanceOf(Response);
    await expect(admission()).rejects.toThrow();
    expect(await count()).toBe(0);
  });
  it("uses distinct cases rather than repeated visits, and withholds small complementary stage populations", async () => {
    await cohort(1, 12);
    expect(await dwell()).toEqual([
      {
        stage_key: "build",
        group: null,
        n: 0,
        open_n: 0,
        p50_ms: null,
        p90_ms: null,
        mean_ms: null,
        suppressed: true,
      },
    ]);
    await cohort(6);
    expect(await dwell()).toMatchObject([{ n: 6, mean_ms: 100, suppressed: false }]);
    // Five cases reached build, one did not. Publishing build plus a related total
    // would expose the one-case complement. Withhold the whole answer.
    await env.DB.prepare(
      "DELETE FROM lifecycle_stage_intervals WHERE app_id = ? AND case_id = 'c5'",
    )
      .bind(APP)
      .run();
    expect(await dwell()).toMatchObject([{ n: 0, open_n: 0, mean_ms: null, suppressed: true }]);
    // A single censored case is also a small population, not a safe open count.
    await cohort(6);
    await env.DB.prepare(
      "UPDATE lifecycle_stage_intervals SET exited_at = NULL WHERE app_id = ? AND case_id = 'c5'",
    )
      .bind(APP)
      .run();
    expect(await dwell()).toMatchObject([{ n: 0, open_n: 0, mean_ms: null, suppressed: true }]);
  });
  it("validates stage registration/duration and hard case/interval output bounds", async () => {
    await cohort(5);
    for (const value of [q.from + 367 * DAY, q.from + 0.5]) {
      await env.DB.prepare("UPDATE lifecycle_stage_intervals SET exited_at = ? WHERE app_id = ?")
        .bind(value, APP)
        .run();
      await expect(dwell()).rejects.toThrow();
    }
    await env.DB.prepare(
      "UPDATE lifecycle_stage_intervals SET stage_key = 'unregistered', exited_at = entered_at + 100 WHERE app_id = ?",
    )
      .bind(APP)
      .run();
    await expect(dwell()).rejects.toThrow();
    await cohort(1);
    await env.DB.prepare(`INSERT INTO lifecycle_stage_intervals
      (app_id, case_id, seq, stage_key, state, entered_at, exited_at, generation)
      SELECT ?, 'c0', value + 1, 'build', 'active', ?, ?, 2 FROM json_each(?)`)
      .bind(APP, q.from, q.from + 100, JSON.stringify(Array.from({ length: 10001 }, (_, i) => i)))
      .run();
    await expect(dwell()).rejects.toThrow();
    await expect(
      executeRead(env.DB, APP, {
        method: "getCaseTimeline",
        caseId: "c0",
        limit: 100,
        cursor: null,
      }),
    ).rejects.toThrow();
    await env.DB.prepare(`INSERT INTO lifecycle_case_snapshots
      (app_id, case_id, process_key, process_version, status, started_at, ended_at,
        last_event_at, generation, source_watermark, reducer_version, as_of, updated_at)
      SELECT ?, 'extra_' || value, ?, 1, 'closed', ?, ?, ?, 2, 17, 'lifecycle@1', ?, ? FROM json_each(?)`)
      .bind(
        APP,
        q.workflowKey,
        q.from,
        q.from + 100,
        q.from + 100,
        Date.now(),
        Date.now(),
        JSON.stringify(Array.from({ length: 1001 }, (_, i) => i)),
      )
      .run();
    await expect(dwell()).rejects.toThrow();
  });
  it("rechecks grants at the read after admission, retaining the already spent reservation", async () => {
    await cohort(5);
    const r = await admission();
    await env.DB.prepare("UPDATE authz_grants SET revoked_at = 1 WHERE principal_subject = ?")
      .bind(p.sub)
      .run();
    await expect(executeRead(env.DB, APP, q, r, checkAccess)).rejects.toThrow();
    expect(await count()).toBe(1);
    await expect(admission()).rejects.toThrow();
    expect(await count()).toBe(1);
  });
});

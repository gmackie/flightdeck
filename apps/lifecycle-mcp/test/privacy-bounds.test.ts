import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor, LIMITS } from "../src/bounds";
import { suppressVariants } from "../src/privacy";
import type { LifecycleReadSource, WorkflowDefinition } from "../src/source";
import { SyntheticLifecycleSource } from "../src/sources/synthetic";
import { syntheticCases } from "../src/sources/synthetic-data";
import { call, connect, ENV, now, RELEASE, SUPPORT, synthetic } from "./helpers";

const rollout = { app_id: RELEASE, workflow_key: "change-rollout" };

describe("small-cohort suppression", () => {
  it("withholds groups below k without counts, plus one complementary group", async () => {
    const client = await connect();
    const res = await call(client, "get_stage_dwell", { ...rollout, group_by: "service_tier" });
    const review = res.data.data.stages.filter(
      (s: { stage_key: string }) => s.stage_key === "review",
    );
    const byGroup = Object.fromEntries(review.map((s: { group: string }) => [s.group, s]));
    // tier3 has 2 cases in version 2.
    expect(byGroup.tier3).toEqual({
      stage_key: "review",
      group: "tier3",
      suppressed: true,
      reason: "small_cohort",
    });
    // Otherwise tier3 = total - tier1 - tier2 from an ungrouped call.
    expect(byGroup.tier1).toMatchObject({ suppressed: true, reason: "complementary" });
    expect(byGroup.tier2).toMatchObject({ suppressed: false, n: expect.any(Number) });
    expect(res.data.privacy).toEqual({ min_cohort: 5, any_suppressed: true });
  });

  it("suppresses a whole cohort that filters narrow below k", async () => {
    const client = await connect();
    const res = await call(client, "get_funnel", {
      ...rollout,
      filters: [{ dimension: "service_tier", value: "tier3" }],
    });
    expect(res.data.data.groups).toEqual([
      { group: null, suppressed: true, reason: "small_cohort" },
    ]);
  });

  it("withholds rare funnel groups (2 phone tickets) and honours a higher k", async () => {
    const client = await connect();
    const res = await call(client, "get_funnel", {
      app_id: SUPPORT,
      workflow_key: "support-ticket",
      group_by: "channel",
    });
    const phone = res.data.data.groups.find((g: { group: string }) => g.group === "phone");
    expect(phone).toEqual({ group: "phone", suppressed: true, reason: "small_cohort" });

    const strict = await connect({ env: { ...ENV, LIFECYCLE_MCP_MIN_COHORT: "1000" } });
    const all = await call(strict, "get_stage_dwell", {
      app_id: SUPPORT,
      workflow_key: "support-ticket",
    });
    expect(all.data.privacy.min_cohort).toBe(1000);
    expect(all.data.data.stages.every((s: { suppressed: boolean }) => s.suppressed)).toBe(true);
  });

  it("pools rare path variants so no path under k is shown or recoverable", () => {
    const def = { stages: [{ key: "a" }, { key: "b" }] } as unknown as WorkflowDefinition;
    const released = suppressVariants(
      {
        total_n: 30,
        completed_n: 30,
        median_cycle_ms: 10,
        variants: [
          { path: ["a", "b"], n: 22, completed_n: 22, median_cycle_ms: 9 },
          { path: ["a"], n: 6, completed_n: 6, median_cycle_ms: 3 },
          { path: ["b"], n: 2, completed_n: 2, median_cycle_ms: 1 },
        ],
      },
      def,
      5,
    );
    if (released.suppressed) throw new Error("expected a released cohort");
    // ["b"] (2) alone would make "other" recoverable as 30 - 22 - 6, so ["a"] is pooled too.
    expect(released.variants.map((v) => v.path)).toEqual([["a", "b"]]);
    expect(released.other).toEqual({ suppressed: false, n: 8 });
  });

  it("drops fields and values a source returns that the definition does not declare", async () => {
    class LeakySource extends SyntheticLifecycleSource {
      override async getCaseSummary(...args: Parameters<LifecycleReadSource["getCaseSummary"]>) {
        const res = await super.getCaseSummary(...args);
        if (!res.data) return res;
        const data = {
          ...res.data,
          outcome: "fired_for_cause",
          notes: "Candidate seemed nervous in the panel",
          assignee_email: "manager@example.com",
          dimensions: {
            ...res.data.dimensions,
            channel: "free text here",
            employee_name: "Jane Doe",
          },
        };
        return { ...res, data };
      }
    }
    const leaky = new LeakySource({ now });
    const support = syntheticCases().find((c) => c.appId === SUPPORT);
    const client = await connect({ source: leaky });
    const res = await call(client, "get_case_summary", {
      app_id: SUPPORT,
      case_id: support?.case_id,
    });
    expect(res.isError).toBe(false);
    for (const secret of [
      "nervous",
      "manager@example.com",
      "Jane Doe",
      "free text",
      "fired_for_cause",
      "notes",
    ]) {
      expect(res.text).not.toContain(secret);
    }
    expect(res.data.data.case.outcome).toBeNull();
    expect(Object.keys(res.data.data.case.dimensions)).toEqual(["priority"]);
  });
});

describe("bounded output", () => {
  it("rejects limits, windows and filters outside the bounds", async () => {
    const client = await connect();
    const cases: [string, Record<string, unknown>, string][] = [
      [
        "list_workflow_definitions",
        { app_id: RELEASE, limit: LIMITS.maxPageSize + 1 },
        "input_validation",
      ],
      ["get_stage_dwell", { ...rollout, from: "2025-01-01", to: "2026-10-01" }, "invalid_argument"],
      ["get_stage_dwell", { ...rollout, from: "2026-10-01", to: "2026-09-01" }, "invalid_argument"],
      ["get_stage_dwell", { ...rollout, to: "2027-06-01" }, "invalid_argument"],
      ["get_stage_dwell", { ...rollout, from: "last tuesday" }, "invalid_argument"],
      ["get_stage_dwell", { ...rollout, group_by: "employee_id" }, "invalid_argument"],
      [
        "get_stage_dwell",
        { ...rollout, filters: [{ dimension: "service_tier", value: "tier9" }] },
        "invalid_argument",
      ],
      ["get_funnel", { ...rollout, stages: ["review", "not_a_stage"] }, "invalid_argument"],
      ["get_case_summary", { app_id: RELEASE, case_id: "jane@example.com" }, "input_validation"],
    ];
    for (const [name, args, code] of cases) {
      const res = await call(client, name, args);
      expect(res.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
      expect(res.error?.code).toBe(code);
    }
  });

  it("pages timelines with bounded, tamper-evident cursors", async () => {
    const target = syntheticCases().find((c) => c.appId === RELEASE && c.intervals.length >= 6);
    const client = await connect();
    const args = { app_id: RELEASE, case_id: target?.case_id, limit: 2 };
    const first = await call(client, "get_case_timeline", args);
    expect(first.data.data.entries).toHaveLength(2);
    const second = await call(client, "get_case_timeline", {
      ...args,
      cursor: first.data.page.next_cursor,
    });
    expect(second.data.page.page).toBe(2);
    expect(second.data.data.entries[0]).not.toEqual(first.data.data.entries[0]);
    // A cursor is only valid for the same query.
    const changed = await call(client, "get_case_timeline", {
      ...args,
      limit: 3,
      cursor: first.data.page.next_cursor,
    });
    expect(changed.error?.code).toBe("invalid_argument");
    const forged = await call(client, "get_case_timeline", { ...args, cursor: "eyJ2IjoxfQ" });
    expect(forged.error?.code).toBe("invalid_argument");
  });

  it("ends every cursor chain after maxPages pages", async () => {
    const binding = { tool: "t", appId: "a", query: {} };
    expect(await encodeCursor(binding, LIMITS.maxPages, "next")).toBeNull();
    const last = await encodeCursor(binding, LIMITS.maxPages - 1, "next");
    expect(await decodeCursor(last ?? undefined, binding)).toEqual({
      page: LIMITS.maxPages,
      sourceCursor: "next",
    });
  });

  it("refuses results over the output budget instead of truncating silently", async () => {
    const big = synthetic();
    const label = "x".repeat(120);
    const def: WorkflowDefinition = {
      workflow_key: "big",
      version: 1,
      label,
      description: label,
      stages: Array.from({ length: 50 }, (_, i) => ({
        key: `s${i}`,
        label,
        order: i,
        terminal: false,
      })),
      outcomes: [],
      dimensions: [],
      published_at: now(),
    };
    big.listWorkflowDefinitions = async () => ({
      data: {
        items: Array.from({ length: 50 }, (_, i) => ({ ...def, version: i + 1 })),
        next_cursor: null,
      },
      meta: {
        as_of: now(),
        freshness: { status: "fresh", watermark: now(), lag_ms: 0 },
        source_version: "t",
      },
    });
    const client = await connect({ source: big });
    const res = await call(client, "list_workflow_definitions", { app_id: RELEASE, limit: 50 });
    expect(res.error?.code).toBe("result_too_large");
  });

  it("caps argument size and request bodies", async () => {
    const client = await connect();
    const res = await call(client, "get_stage_dwell", {
      ...rollout,
      filters: Array.from({ length: 40 }, () => ({ dimension: "service_tier", value: "tier1" })),
    });
    expect(res.isError).toBe(true);
  });
});

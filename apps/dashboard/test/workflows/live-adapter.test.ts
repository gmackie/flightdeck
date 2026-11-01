import { describe, expect, it } from "vitest";
import { diagnoseWorkflowSnapshot } from "../../src/workflows/adapter";
import {
  buildPortfolios,
  caseNode,
  caseStages,
  caseState,
  isCaseDetailEnvelope,
  isOutcomeList,
  isProcessList,
  liveSnapshot,
  outcomeState,
  shortId,
} from "../../src/workflows/live-adapter";
import { flattenNodes } from "../../src/workflows/model";
import { DETAIL_CONCURRENCY, fetchLiveWorkflows } from "../../src/workflows/use-live-workflows";
import {
  AS_OF,
  CHILD,
  detail,
  envelope,
  HIRING,
  HOUR,
  lifecycleFetcher,
  OUTCOMES,
  PARENT,
  summary,
} from "./lifecycle-api";

const byId = (stages: ReturnType<typeof caseStages>) =>
  Object.fromEntries(stages.map((stage) => [stage.id, stage]));

describe("live lifecycle mapping", () => {
  it("maps every definition stage in order, from real interval timestamps", () => {
    const stages = caseStages(HIRING, PARENT);
    expect(stages.map((stage) => stage.label)).toEqual(["Applied", "Screen", "Offer", "Done"]);
    expect(stages[0]).toMatchObject({
      state: "completed",
      owner: "—",
      enteredAt: AS_OF - 10 * HOUR,
      exitedAt: AS_OF - 2 * HOUR,
    });
    expect(stages[1]).toMatchObject({ state: "active", enteredAt: AS_OF - 2 * HOUR });
    expect(stages[1]).not.toHaveProperty("exitedAt");
    expect(stages[2]).toEqual({ id: "offer", label: "Offer", state: "future", owner: "—" });
  });

  it("maps open blocked and paused segments to waiting and paused", () => {
    const blocked = detail(summary({ case_id: "c1" }), [
      { stage_key: "applied", entered_at: 0, state: "blocked" },
    ]);
    const paused = detail(summary({ case_id: "c2" }), [
      { stage_key: "applied", entered_at: 0, state: "paused" },
    ]);
    expect(byId(caseStages(HIRING, blocked)).applied?.state).toBe("waiting");
    expect(caseState(blocked)).toBe("waiting");
    expect(byId(caseStages(HIRING, paused)).applied?.state).toBe("paused");
    expect(caseState(paused)).toBe("paused");
  });

  it("merges consecutive segments of one visit and shows the latest re-entry", () => {
    const reopened = detail(summary({ case_id: "c3" }), [
      { stage_key: "applied", entered_at: 0, exited_at: 10 },
      { stage_key: "screen", entered_at: 10, exited_at: 20, state: "active" },
      { stage_key: "screen", entered_at: 20, exited_at: 30, state: "paused" },
      { stage_key: "offer", entered_at: 30, exited_at: 40 },
      { stage_key: "screen", entered_at: 40, exited_at: 50, state: "active" },
      { stage_key: "screen", entered_at: 50, state: "blocked" },
    ]);
    const stages = byId(caseStages(HIRING, reopened));
    expect(stages.screen).toMatchObject({ state: "waiting", enteredAt: 40 });
    expect(stages.screen).not.toHaveProperty("exitedAt");
    expect(stages.screen?.reason).toContain("Entered 2 times");
    expect(stages.offer).toMatchObject({ state: "completed", enteredAt: 30, exitedAt: 40 });

    const split = detail(summary({ case_id: "c4" }), [
      { stage_key: "applied", entered_at: 0, exited_at: 10, state: "active" },
      { stage_key: "applied", entered_at: 10, exited_at: 25, state: "paused" },
    ]);
    expect(byId(caseStages(HIRING, split)).applied).toMatchObject({
      state: "completed",
      enteredAt: 0,
      exitedAt: 25,
    });
  });

  it("maps a closed case's final stage and state from its outcome", () => {
    expect(byId(caseStages(HIRING, CHILD)).screen).toMatchObject({
      state: "rejected",
      exitedAt: AS_OF - 3 * HOUR,
    });
    expect(byId(caseStages(HIRING, CHILD)).applied?.state).toBe("completed");
    expect(caseState(CHILD)).toBe("rejected");
    expect(outcomeState("reject")).toBe("rejected");
    expect(outcomeState("withdrawn")).toBe("withdrawn");
    expect(outcomeState("cancelled")).toBe("cancelled");
    expect(outcomeState("hired")).toBe("completed");
    expect(outcomeState(null)).toBe("completed");
  });

  it("appends stage keys the definition does not know instead of dropping them", () => {
    const odd = detail(summary({ case_id: "c5" }), [{ stage_key: "legacy", entered_at: 0 }]);
    expect(caseStages(HIRING, odd).at(-1)).toMatchObject({ id: "legacy", label: "legacy" });
  });

  it("labels nodes from the process label and a short id, with no owner", () => {
    expect(shortId("short")).toBe("short");
    expect(shortId("case_01PARENTAAAA1111")).toBe("…AAAA1111");
    expect(caseNode(HIRING, PARENT)).toMatchObject({
      id: PARENT.case_id,
      label: "Hiring · …AAAA1111",
      kind: "Hiring",
      owner: "—",
      state: "active",
      createdAt: PARENT.started_at,
    });
    expect(caseNode(HIRING, PARENT).outcome).toBeUndefined();
    expect(caseNode(HIRING, CHILD)).toMatchObject({ outcome: "rejected", endedAt: CHILD.ended_at });
  });

  it("nests cases under fetched parents, across processes, and keeps orphans and cycles as roots", () => {
    const review = { ...HIRING, process_key: "review", version: 1, label: "Review" };
    const crossChild = detail(
      summary({ case_id: "x1", process_key: "review", parent_case_id: PARENT.case_id }),
      [],
    );
    const orphan = detail(summary({ case_id: "o1", parent_case_id: "missing" }), []);
    const cycleA = detail(summary({ case_id: "a", parent_case_id: "b" }), []);
    const cycleB = detail(summary({ case_id: "b", parent_case_id: "a" }), []);
    const [hiring, reviews] = buildPortfolios([
      { process: HIRING, cases: [PARENT, CHILD, orphan, cycleA, cycleB] },
      { process: review, cases: [crossChild] },
    ]);
    expect(hiring?.id).toBe("hiring@v2");
    expect(hiring?.label).toBe("Hiring · v2");
    expect(hiring?.roots.map((node) => node.id)).toEqual([PARENT.case_id, "o1", "a", "b"]);
    expect(hiring?.roots[0]?.children?.map((node) => node.id)).toEqual([CHILD.case_id, "x1"]);
    expect(reviews?.roots).toEqual([]);
  });

  it("keeps invalid live timings visible to diagnoseWorkflowSnapshot", () => {
    const bad = detail(summary({ case_id: "bad" }), [
      { stage_key: "applied", entered_at: 100, exited_at: 50 },
      { stage_key: "screen", entered_at: AS_OF + HOUR },
    ]);
    const snapshot = liveSnapshot([{ process: HIRING, cases: [bad] }], AS_OF);
    expect(snapshot.source.synthetic).toBe(false);
    const messages = diagnoseWorkflowSnapshot(snapshot).map((d) => `${d.stageId}: ${d.message}`);
    expect(messages).toEqual([
      "applied: Exit is before entry",
      "screen: Entry is after the snapshot",
    ]);
    const node = flattenNodes(snapshot.portfolios[0]?.roots ?? [])[0];
    expect(node?.stages[0]).toMatchObject({ enteredAt: 100, exitedAt: 50 });
  });

  it("validates response envelopes", () => {
    expect(isProcessList(envelope([HIRING]))).toBe(true);
    expect(isCaseDetailEnvelope(envelope(PARENT))).toBe(true);
    expect(isOutcomeList(envelope(OUTCOMES))).toBe(true);
    expect(isCaseDetailEnvelope(envelope({ ...PARENT, intervals: undefined }))).toBe(false);
    expect(isProcessList({ ...envelope([HIRING]), data_freshness: { status: "ok" } })).toBe(false);
  });
});

describe("fetchLiveWorkflows", () => {
  it("reads processes, cases, details and outcomes into one snapshot", async () => {
    const fetcher = lifecycleFetcher();
    const result = await fetchLiveWorkflows("app_alpha", fetcher);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.asOf).toBe(AS_OF);
    expect(result.data.freshness.pending_cases).toBe(2);
    expect(result.data.processes[0]).toMatchObject({ id: "hiring@v2", unavailableCases: 0 });
    expect(result.data.processes[0]?.outcomes.status).toBe("ok");
    expect(flattenNodes(result.data.snapshot?.portfolios[0]?.roots ?? [])).toHaveLength(2);
    const paths = fetcher.mock.calls.map(([input]) => String(input));
    expect(paths).toContain(
      "/api/apps/app_alpha/lifecycle/cases?process_key=hiring&version=2&limit=25",
    );
    expect(paths).toContain(
      "/api/apps/app_alpha/lifecycle/summaries/outcomes?process_key=hiring&version=2",
    );
    expect(paths).toContain(`/api/apps/app_alpha/lifecycle/cases/${PARENT.case_id}`);
  });

  it("stops after processes while the read model is unavailable", async () => {
    const unavailable = {
      status: "unavailable",
      projection: "none",
      lag_ms: null,
      generation: null,
      source_watermark: null,
    };
    const fetcher = lifecycleFetcher({
      processes: { body: envelope([], { as_of: null, data_freshness: unavailable }) },
    });
    const result = await fetchLiveWorkflows("app_alpha", fetcher);
    expect(result).toMatchObject({ status: "ok", data: { snapshot: null, asOf: null } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("fails the whole read on 403, but only the outcome panel on an aggregate 403", async () => {
    expect(
      await fetchLiveWorkflows("app_alpha", lifecycleFetcher({ processes: { status: 403 } })),
    ).toEqual({ status: "forbidden" });
    expect(
      await fetchLiveWorkflows("app_alpha", lifecycleFetcher({ detail: { status: 403 } })),
    ).toEqual({ status: "forbidden" });
    const degraded = await fetchLiveWorkflows(
      "app_alpha",
      lifecycleFetcher({ outcomes: { status: 403 } }),
    );
    expect(degraded.status).toBe("ok");
    if (degraded.status === "ok")
      expect(degraded.data.processes[0]?.outcomes).toEqual({ status: "forbidden" });
  });

  it("counts details that vanished between list and read instead of inventing them", async () => {
    const gone = summary({ case_id: "case_gone" });
    const fetcher = lifecycleFetcher({
      cases: { body: envelope([PARENT, gone]) },
    });
    const result = await fetchLiveWorkflows("app_alpha", fetcher);
    if (result.status !== "ok") throw new Error(result.status);
    expect(result.data.processes[0]?.unavailableCases).toBe(1);
    expect(flattenNodes(result.data.snapshot?.portfolios[0]?.roots ?? [])).toHaveLength(1);
  });

  it("bounds concurrent detail reads", async () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      detail(summary({ case_id: `case_${i}` }), [{ stage_key: "applied", entered_at: 0 }]),
    );
    const base = lifecycleFetcher(undefined, many);
    let inFlight = 0;
    let peak = 0;
    const fetcher = async (input: RequestInfo | URL) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      try {
        return await base(input);
      } finally {
        inFlight--;
      }
    };
    const result = await fetchLiveWorkflows("app_alpha", fetcher as typeof fetch);
    expect(result.status).toBe("ok");
    expect(peak).toBeLessThanOrEqual(DETAIL_CONCURRENCY);
  });
});

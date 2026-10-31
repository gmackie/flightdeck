// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { demoWorkflowAdapter, diagnoseWorkflowSnapshot } from "../../src/workflows/adapter";
import { ASSESSMENT_STAGES, DEMO_AS_OF, LOOP_STAGES } from "../../src/workflows/fixtures";
import {
  duration,
  filterHierarchy,
  flattenNodes,
  type LifecycleNode,
  type LifecycleStage,
  percentile,
  stageDwell,
  stageTimeProblem,
  summarizePortfolio,
} from "../../src/workflows/model";

const css = readFileSync(new URL("../../src/workflows/workflows.css", import.meta.url), "utf8");

const stage: LifecycleStage = {
  id: "review",
  label: "Review",
  state: "active",
  owner: "Example team",
  enteredAt: 100,
};
const node: LifecycleNode = {
  id: "parent",
  label: "Parent",
  kind: "Example",
  state: "active",
  owner: "Example team",
  createdAt: 0,
  stages: [stage],
  children: [
    {
      id: "child",
      label: "Child",
      kind: "Independent task",
      state: "rejected",
      owner: "Other team",
      createdAt: 0,
      stages: [{ ...stage, state: "rejected", exitedAt: 300 }],
    },
  ],
};

describe("dashboard lifecycle read model", () => {
  it("measures open and exited dwell separately from age; never invents future dwell", () => {
    expect(stageDwell(stage, 1000)).toBe(900);
    expect(stageDwell({ ...stage, exitedAt: 300 }, 1000)).toBe(200);
    expect(stageDwell({ ...stage, enteredAt: undefined, state: "future" }, 1000)).toBeUndefined();
    expect(stageDwell(stage, 50)).toBeUndefined();
    expect(duration(-1)).toBe("—");
    expect(duration(Number.NaN)).toBe("—");
    expect(duration(undefined)).toBe("—");
    expect(duration(90 * 60_000)).toBe("1h 30m");
    expect(duration(49 * 3_600_000)).toBe("2d 1h");
  });

  it("uses nearest-rank p50/p90 without mutating input", () => {
    const values = [1000, 100, 300, 200, 400];
    expect(percentile(values, 0.5)).toBe(300);
    expect(percentile(values, 0.9)).toBe(1000);
    expect(values).toEqual([1000, 100, 300, 200, 400]);
    expect(percentile([], 0.5)).toBeUndefined();
    expect(percentile([7], 0.9)).toBe(7);
  });

  it("separates open ages from completed dwell and counts parent/child outcomes independently", () => {
    const summary = summarizePortfolio([node], 1000);
    expect(summary).toMatchObject({
      total: 2,
      completedDwell: { p50: undefined, p90: undefined, count: 0 },
      openStageAge: { p50: 900, p90: 900, count: 1 },
      invalidStages: 0,
    });
    expect(summary.counts).toMatchObject({ active: 1, rejected: 1, completed: 0 });
    expect(summarizePortfolio([], 1000)).toMatchObject({
      total: 0,
      completedDwell: { p50: undefined, p90: undefined, count: 0 },
      openStageAge: { p50: undefined, p90: undefined, count: 0 },
    });
    expect(node.state).toBe("active");
  });

  it("does not let right-censored ages change completed p50/p90 as snapshot time advances", () => {
    const cohort: LifecycleNode = {
      ...node,
      children: [],
      stages: [
        { ...stage, id: "short", state: "completed", enteredAt: 0, exitedAt: 100 },
        { ...stage, id: "long", state: "completed", enteredAt: 0, exitedAt: 300 },
        { ...stage, id: "open", enteredAt: 0 },
        { ...stage, id: "failed", state: "rejected", enteredAt: 0, exitedAt: 900 },
        { ...stage, id: "future", state: "future", enteredAt: undefined },
      ],
    };
    const first = summarizePortfolio([cohort], 1000);
    const later = summarizePortfolio([cohort], 10_000);
    expect(first.completedDwell).toEqual({ p50: 100, p90: 300, count: 2 });
    expect(later.completedDwell).toEqual(first.completedDwell);
    expect(first.openStageAge).toEqual({ p50: 1000, p90: 1000, count: 1 });
    expect(later.openStageAge).toEqual({ p50: 10_000, p90: 10_000, count: 1 });
  });

  it.each([
    [{ ...stage, enteredAt: 1001 }, "Entry is after the snapshot"],
    [{ ...stage, exitedAt: 99 }, "Exit is before entry"],
    [{ ...stage, exitedAt: 1001 }, "Exit is after the snapshot"],
    [{ ...stage, enteredAt: Number.NaN }, "Entry timestamp is invalid"],
    [{ ...stage, exitedAt: Number.POSITIVE_INFINITY }, "Exit timestamp is invalid"],
    [{ ...stage, enteredAt: undefined, exitedAt: 300 }, "Exit timestamp has no entry"],
    [{ ...stage, enteredAt: undefined }, "Entered stage is missing its entry timestamp"],
    [{ ...stage, state: "completed" }, "Terminal stage is missing its exit timestamp"],
    [{ ...stage, state: "future" }, "Future stage has recorded timestamps"],
  ] satisfies [LifecycleStage, string][])(
    "excludes invalid stage timing with diagnostics: %j",
    (invalid, message) => {
      expect(stageDwell(invalid, 1000)).toBeUndefined();
      expect(stageTimeProblem(invalid, 1000)).toBe(message);
      const source = {
        asOf: 1000,
        source: { label: "Test", synthetic: true },
        portfolios: [
          {
            id: "test",
            label: "Test",
            description: "Test",
            roots: [{ ...node, children: [], stages: [invalid] }],
          },
        ],
      };
      const diagnostics = diagnoseWorkflowSnapshot(source);
      expect(diagnostics).toEqual([
        {
          portfolioId: "test",
          nodeId: "parent",
          stageId: "review",
          nodeLabel: "Parent",
          stageLabel: "Review",
          message,
        },
      ]);
      const summary = summarizePortfolio(source.portfolios[0]?.roots ?? [], 1000);
      expect(summary.invalidStages).toBe(1);
      expect(summary.completedDwell.count).toBe(0);
      expect(summary.openStageAge.count).toBe(0);
      expect(source.portfolios[0]?.roots[0]?.stages[0]).toBe(invalid);
    },
  );

  it("accepts zero-duration completed stages and rejects an invalid snapshot timestamp", () => {
    expect(stageDwell({ ...stage, state: "completed", exitedAt: 100 }, 1000)).toBe(0);
    expect(stageDwell(stage, Number.NaN)).toBeUndefined();
    expect(stageTimeProblem(stage, Number.NaN)).toBe("Snapshot timestamp is invalid");
    expect(diagnoseWorkflowSnapshot(demoWorkflowAdapter.read())).toEqual([]);
  });

  it("preserves ancestors and their own lifecycle during descendant searches", () => {
    const filtered = filterHierarchy([node], " REJECTED ");
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.stages).toBe(node.stages);
    expect(filtered[0]?.state).toBe("active");
    expect(filtered[0]?.children?.[0]?.id).toBe("child");
    expect(filterHierarchy([node], "missing")).toEqual([]);
    expect(filterHierarchy([node], " ")).toEqual([node]);
  });

  it("keeps loop, assessment and application lifecycles separate in synthetic fixtures", () => {
    const snapshot = demoWorkflowAdapter.read();
    expect(snapshot.source.synthetic).toBe(true);
    expect(snapshot.asOf).toBe(DEMO_AS_OF);
    expect(snapshot.portfolios.map((p) => p.id)).toEqual(["headcount", "deployments", "incidents"]);
    const nodes = flattenNodes(snapshot.portfolios[0]?.roots ?? []);
    expect(nodes.filter((n) => n.kind === "Requisition")).toHaveLength(12);
    const loop = nodes.find((n) => n.kind === "Interview loop");
    expect(loop?.stages.map((s) => s.label)).toEqual(LOOP_STAGES);
    expect(loop?.children).toHaveLength(3);
    for (const assessment of loop?.children ?? []) {
      expect(assessment.stages.map((s) => s.label)).toEqual(ASSESSMENT_STAGES);
      expect(assessment.relationship).toContain("Parallel");
    }
    expect(new Set(loop?.children?.map((n) => n.state))).toEqual(
      new Set(["active", "waiting", "completed"]),
    );
    expect(nodes.find((n) => n.kind === "Application")?.stages.map((s) => s.label)).not.toEqual(
      LOOP_STAGES,
    );
    expect(nodes.filter((n) => n.kind === "Headcount demand").map((n) => n.state)).toEqual(
      expect.arrayContaining(["waiting", "deferred", "rejected"]),
    );
    expect(new Set(nodes.map((n) => n.id)).size).toBe(nodes.length);
  });

  it("has WCAG AA text contrast for every actual lifecycle fill/ink pair in both themes", () => {
    const luminance = (hex: string) => {
      const rgb =
        hex.match(/\w\w/g)?.map((part) => {
          const value = Number.parseInt(part, 16) / 255;
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        }) ?? [];
      return (rgb[0] ?? 0) * 0.2126 + (rgb[1] ?? 0) * 0.7152 + (rgb[2] ?? 0) * 0.0722;
    };
    const pairs = [...css.matchAll(/--wf-fill: #(\w{6});\s*--wf-ink: #(\w{6});/g)];
    expect(pairs.length).toBeGreaterThanOrEqual(8);
    for (const [, fill = "", ink = ""] of pairs) {
      const a = luminance(fill);
      const b = luminance(ink);
      expect(
        (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
        `${fill}/${ink}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});

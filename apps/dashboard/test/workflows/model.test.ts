// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { demoWorkflowAdapter } from "../../src/workflows/adapter";
import { ASSESSMENT_STAGES, DEMO_AS_OF, LOOP_STAGES } from "../../src/workflows/fixtures";
import {
  duration,
  filterHierarchy,
  flattenNodes,
  type LifecycleNode,
  type LifecycleStage,
  percentile,
  stageDwell,
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
    expect(stageDwell(stage, 50)).toBe(0);
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

  it("summarizes all entered stages and counts parent and child outcomes independently", () => {
    const summary = summarizePortfolio([node], 1000);
    expect(summary).toMatchObject({ total: 2, p50: 200, p90: 900, samples: 2 });
    expect(summary.counts).toMatchObject({ active: 1, rejected: 1, completed: 0 });
    expect(summarizePortfolio([], 1000)).toMatchObject({
      total: 0,
      p50: undefined,
      p90: undefined,
      samples: 0,
    });
    expect(node.state).toBe("active");
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

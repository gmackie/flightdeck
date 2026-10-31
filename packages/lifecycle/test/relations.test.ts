import { describe, expect, it } from "vitest";
import { caseMetrics, id, replay, selectCases } from "../src/index.js";
import { caseId, event, fixture, processId, rollout, start } from "./fixtures.js";

describe("object-centric relations and child processes", () => {
  it("supports many-to-many case/object relations with link/unlink/relink history", () => {
    const other = id<"case">("other-application");
    const data = fixture([start(), start(1, other)]);
    const shared = { type: "person", id: "shared-person" };
    const links = Array.from({ length: 100 }, (_, n) =>
      event(`link-${n}`, n + 2, {
        type: "relation.link",
        relation: {
          id: id<"relation">(`relation-${n}`),
          kind: "associated",
          from: { type: "case", id: n % 2 ? caseId : other },
          to: n < 2 ? shared : { type: "object", id: `object-${n % 10}` },
        },
      }),
    );
    const result = replay({
      ...data,
      asOf: 200,
      cases: [...data.cases, { id: other, processId }],
      stageInstances: [],
      events: [
        ...data.events,
        ...links,
        event("unlink", 120, { type: "relation.unlink", relationId: id<"relation">("relation-1") }),
        event("relink", 140, {
          type: "relation.link",
          relation: {
            id: id<"relation">("relation-1"),
            kind: "associated",
            from: { type: "case", id: caseId },
            to: shared,
          },
        }),
      ],
    });
    expect(result.relations).toHaveLength(100);
    expect(result.relations.find((r) => r.id === "relation-1")?.intervals).toEqual([
      { start: 3, end: 120 },
      { start: 140, end: null },
    ]);
    expect(selectCases(result, { relatedObject: shared })).toHaveLength(2);
    expect(result.diagnostics).toEqual([]);
  });

  it("does not change relation identity or invent a link when unlink is missing", () => {
    const data = fixture([start()]);
    const relationId = id<"relation">("r");
    const relation = {
      id: relationId,
      kind: "association",
      from: { type: "case", id: caseId },
      to: { type: "service", id: "a" },
    };
    const result = replay({
      ...data,
      stageInstances: [],
      events: [
        ...data.events,
        event("unlink-first", 1, { type: "relation.unlink", relationId }),
        event("link", 2, { type: "relation.link", relation }),
        event("bad-link", 3, {
          type: "relation.link",
          relation: { ...relation, to: { type: "service", id: "b" } },
        }),
        event("unlink", 4, { type: "relation.unlink", relationId }),
      ],
    });
    expect(result.diagnostics.map((d) => d.code)).toEqual(
      expect.arrayContaining(["missing_boundary", "invalid_transition"]),
    );
    expect(selectCases(result, { relatedObject: { type: "service", id: "a" } })).toHaveLength(0);
    expect(result.relations[0]?.to.id).toBe("a");
  });

  it("diagnoses child/self cycles without dropping valid parallel children", () => {
    const data = rollout();
    const result = replay({
      ...data,
      events: [
        ...data.events,
        event("cycle", 40, {
          type: "child.link",
          caseId: id<"case">("service-a"),
          childCaseId: caseId,
        }),
        event("self", 41, { type: "child.link", caseId, childCaseId: caseId }),
      ],
    });
    expect(result.children).toHaveLength(2);
    expect(result.diagnostics.filter((d) => d.code === "cycle")).toHaveLength(2);
    expect(caseMetrics(result, caseId).childOverlapMs).toBe(70);
  });

  it("allows historical hierarchy reversal after explicit unlink", () => {
    const data = rollout();
    const a = id<"case">("service-a");
    const result = replay({
      ...data,
      events: [
        ...data.events,
        event("unlink", 40, { type: "child.unlink", caseId, childCaseId: a }),
        event("reverse", 50, { type: "child.link", caseId: a, childCaseId: caseId }),
      ],
    });
    expect(result.children).toHaveLength(3);
    expect(result.diagnostics).toEqual([]);
  });
});

it("supports independent process definitions, parallel child stages and multiple parents", () => {
  const parentProcess = id<"process">("release-v1");
  const childProcess = id<"process">("service-v2");
  const parent = id<"case">("release");
  const otherParent = id<"case">("incident");
  const child = id<"case">("service-rollout");
  const deploy = id<"stage">("deploy");
  const monitor = id<"stage">("monitor");
  const a = id<"stage-instance">("deploy-attempt");
  const b = id<"stage-instance">("monitor-attempt");
  const result = replay({
    definitions: [
      { id: parentProcess, stages: [] },
      { id: childProcess, stages: [{ id: deploy }, { id: monitor }] },
    ],
    cases: [
      { id: parent, processId: parentProcess },
      { id: otherParent, processId: parentProcess },
      { id: child, processId: childProcess },
    ],
    stageInstances: [
      { id: a, caseId: child, stageId: deploy },
      { id: b, caseId: child, stageId: monitor },
    ],
    asOf: 100,
    events: [
      start(0, parent),
      start(1, otherParent),
      start(10, child),
      event("link-release", 2, { type: "child.link", caseId: parent, childCaseId: child }),
      event("link-incident", 3, { type: "child.link", caseId: otherParent, childCaseId: child }),
      event("deploy", 20, { type: "stage.enter", stageInstanceId: a }),
      event("monitor", 30, { type: "stage.enter", stageInstanceId: b }),
      event("deployed", 50, { type: "stage.exit", stageInstanceId: a }),
      event("monitored", 60, { type: "stage.exit", stageInstanceId: b }),
    ],
  });
  expect(caseMetrics(result, parent)).toMatchObject({
    openDurationMs: 100,
    childOverlapMs: 90,
    parallelChildMs: 0,
  });
  expect(caseMetrics(result, otherParent).childOverlapMs).toBe(90);
  expect(result.children).toHaveLength(2);
  expect(result.diagnostics).toEqual([]);
});

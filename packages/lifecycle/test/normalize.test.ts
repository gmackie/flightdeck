import { expect, it } from "vitest";
import type { LifecycleEvent } from "../src/index.js";
import { id, normalizeCanonicalTransition, replay, stageMetrics, summarize } from "../src/index.js";
import { caseId, enter, event, exit, fixture, instance, start, terminate } from "./fixtures.js";

it("normalizes Workstream A canonical names to identical replay semantics", () => {
  const engine = [start(), enter(), exit(), terminate()];
  const names = ["case.started", "stage.entered", "stage.exited", "case.completed"];
  const normalized = engine.map((e, index) =>
    normalizeCanonicalTransition(
      names[index] ?? "",
      {
        id: e.id,
        occurredAt: e.occurredAt,
        source: e.source,
      },
      { caseId, stageInstanceId: instance },
    ),
  );
  const events = normalized.map((n) => {
    if (n.event === null) throw new Error(n.diagnostic.message);
    return n.event;
  });
  expect(replay(fixture(events))).toEqual(replay(fixture(engine)));
  expect(stageMetrics(replay(fixture(events)), instance).wallClockMs).toBe(40);
});

it("requires authoritative termination class and matched interruption identity", () => {
  const envelope = {
    id: id<"event">("canonical"),
    occurredAt: 20,
    source: { id: "app:case:source", sequence: 1 },
  };
  expect(normalizeCanonicalTransition("case.terminated", envelope, { caseId })).toMatchObject({
    event: null,
    diagnostic: { code: "missing_context" },
  });
  expect(
    normalizeCanonicalTransition("case.terminated", envelope, { caseId, terminal: "cancelled" })
      .event,
  ).toMatchObject({ type: "case.terminate", terminal: "cancelled" });
  expect(
    normalizeCanonicalTransition("stage.blocked", envelope, { stageInstanceId: instance }).event,
  ).toBeNull();
  expect(
    normalizeCanonicalTransition("stage.blocked", envelope, {
      stageInstanceId: instance,
      interruptionId: "dependency",
    }).event,
  ).toMatchObject({ type: "stage.block", interruptionId: "dependency" });
});

it.each(["case.created", "event.corrected", "stage.enter", "unknown.event"])(
  "rejects unsupported or incompatible name %s explicitly",
  (type) => {
    const envelope = { id: id<"event">("unsupported"), occurredAt: 20, source: { id: "source" } };
    expect(normalizeCanonicalTransition(type, envelope, {})).toMatchObject({
      event: null,
      diagnostic: { code: "unsupported_transition" },
    });
  },
);

it("normalizes object links/unlinks without guessing relation identity", () => {
  const relationId = id<"relation">("scoped-relation");
  const relation = {
    id: relationId,
    kind: "involves",
    from: { type: "case", id: caseId },
    to: { type: "service", id: "service-a" },
  };
  const envelope = { id: id<"event">("object-link"), occurredAt: 20, source: { id: "source" } };
  expect(normalizeCanonicalTransition("object.linked", envelope, { relation }).event).toMatchObject(
    { type: "relation.link", relation },
  );
  expect(
    normalizeCanonicalTransition("object.unlinked", envelope, { relationId }).event,
  ).toMatchObject({ type: "relation.unlink", relationId });
});

it("diagnoses incompatible names passed directly to replay instead of ignoring them", () => {
  const incompatible = { ...enter(), type: "stage.entered" } as unknown as LifecycleEvent;
  const result = replay(fixture([start(), incompatible]));
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({ code: "unsupported_event", eventId: incompatible.id }),
  );
});

it("canonical interruption normalization preserves overlap semantics", () => {
  const names = ["stage.blocked", "stage.paused", "stage.unblocked", "stage.resumed"];
  const events = names.map((name, index) => {
    const result = normalizeCanonicalTransition(
      name,
      {
        id: id<"event">(`interrupt-${index}`),
        occurredAt: 20 + index * 10,
        source: { id: "source" },
      },
      {
        stageInstanceId: instance,
        interruptionId: name.includes("block") ? "dependency" : "pause",
      },
    );
    if (result.event === null) throw new Error(result.diagnostic.message);
    return result.event;
  });
  expect(
    stageMetrics(
      replay(
        fixture([
          start(),
          enter(),
          ...events,
          exit(60),
          event("end", 80, { type: "case.terminate", caseId, terminal: "completed" }),
        ]),
      ),
      instance,
    ),
  ).toMatchObject({ blockedMs: 20, pausedMs: 20, unavailableMs: 30 });
});

it("requires mapping for A's terminal flag and ends the case on canonical terminal entry", async () => {
  const { normalizeCanonicalDefinition } = await import("../src/index.js");
  const final = id<"stage">("terminal-stage");
  const attempt = id<"stage-instance">("terminal-attempt");
  const canonical = {
    processId: "flow",
    version: 1,
    name: "Flow",
    stages: [{ stageId: "done", name: "Done", terminal: true }],
  };
  const mapping = { processId: id<"process">("flow-v1"), stageIds: new Map([["done", final]]) };
  expect(normalizeCanonicalDefinition(canonical, mapping)).toMatchObject({
    definition: null,
    diagnostic: { code: "missing_context" },
  });
  const mapped = normalizeCanonicalDefinition(canonical, {
    ...mapping,
    terminalClasses: new Map([["done", "completed" as const]]),
  });
  if (mapped.definition === null) throw new Error("Mapping failed");
  const terminal = normalizeCanonicalTransition(
    "stage.entered",
    { id: id<"event">("final"), occurredAt: 50, source: { id: "case-stream" } },
    { stageInstanceId: attempt },
  );
  if (terminal.event === null) throw new Error("Normalization failed");
  const result = replay({
    definitions: [mapped.definition],
    cases: [{ id: caseId, processId: mapped.definition.id }],
    stageInstances: [{ id: attempt, caseId, stageId: final }],
    events: [start(), terminal.event],
    asOf: 1000,
  });
  expect(result.cases[0]).toMatchObject({ status: "terminated", terminal: "completed" });
  expect(summarize(result)).toMatchObject({
    openCensored: 0,
    completionRatio: 1,
    closedCaseDuration: { p50: 50 },
  });
  expect(stageMetrics(result, attempt)).toMatchObject({ activeAgeMs: null, openCensored: false });
});

it("scopes A sequences by app/case across producer names", async () => {
  const { normalizeCanonicalEnvelope } = await import("../src/index.js");
  const first = normalizeCanonicalEnvelope(
    { eventId: "z", caseId: "case", occurredAt: 0, sourceSequence: 1, source: "z-producer" },
    "app",
  );
  const second = normalizeCanonicalEnvelope(
    { eventId: "a", caseId: "case", occurredAt: 0, sourceSequence: 2, source: "a-producer" },
    "app",
  );
  expect(first.source.id).toBe(second.source.id);
  const started = normalizeCanonicalTransition("case.started", first, { caseId });
  const entered = normalizeCanonicalTransition("stage.entered", second, {
    stageInstanceId: instance,
  });
  if (started.event === null || entered.event === null) throw new Error("Normalization failed");
  const result = replay({
    ...fixture([entered.event, started.event]),
    reliableSources: [first.source.id],
  });
  expect(result.events.map((e) => e.source.sequence)).toEqual([1, 2]);
  expect(result.diagnostics).toEqual([]);
});

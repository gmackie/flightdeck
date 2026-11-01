import type { CaseId, LifecycleEvent, ReplayInput, StageInstanceId } from "../src/index.js";
import { id } from "../src/index.js";

export const processId = id<"process">("opaque:process:v1");
export const caseId = id<"case">("opaque:case:one");
export const first = id<"stage">("opaque:stage:first");
export const second = id<"stage">("opaque:stage:second");
export const instance = id<"stage-instance">("opaque:attempt:one");
export type Action = LifecycleEvent extends infer E
  ? E extends LifecycleEvent
    ? Omit<E, "id" | "occurredAt" | "source">
    : never
  : never;
export function event(
  key: string,
  time: number,
  action: Action,
  sequence?: number,
): LifecycleEvent {
  return {
    id: id<"event">(key),
    occurredAt: time,
    source: { id: "fixture", sequence },
    ...action,
  } as LifecycleEvent;
}
export function fixture(events: LifecycleEvent[] = []): ReplayInput {
  return {
    definitions: [{ id: processId, stages: [{ id: first }, { id: second }] }],
    cases: [{ id: caseId, processId, attributes: { region: "east", team: "platform" } }],
    stageInstances: [{ id: instance, caseId, stageId: first }],
    events,
    asOf: 100,
  };
}
export const start = (time = 0, owner: CaseId = caseId) =>
  event(`start:${owner}`, time, { type: "case.start", caseId: owner });
export const enter = (time = 10, attempt: StageInstanceId = instance) =>
  event(`enter:${attempt}`, time, { type: "stage.enter", stageInstanceId: attempt });
export const exit = (time = 50, attempt: StageInstanceId = instance) =>
  event(`exit:${attempt}`, time, { type: "stage.exit", stageInstanceId: attempt });
export const terminate = (time = 80, owner: CaseId = caseId) =>
  event(`end:${owner}`, time, { type: "case.terminate", caseId: owner, terminal: "completed" });

export function hiring(): ReplayInput {
  const interview = id<"stage-instance">("application-attempt-2");
  const offer = id<"stage-instance">("application-offer");
  const data = fixture([
    start(),
    enter(),
    exit(20),
    enter(25, interview),
    exit(40, interview),
    enter(45, offer),
    exit(60, offer),
    terminate(70),
    event("application-object", 1, {
      type: "relation.link",
      relation: {
        id: id<"relation">("application-candidate"),
        kind: "involves",
        from: { type: "case", id: caseId },
        to: { type: "person", id: "person-opaque" },
      },
    }),
  ]);
  return {
    ...data,
    stageInstances: [
      ...data.stageInstances,
      { id: interview, caseId, stageId: first },
      { id: offer, caseId, stageId: second },
    ],
  };
}

export function rollout(): ReplayInput {
  const a = id<"case">("service-a");
  const b = id<"case">("service-b");
  const data = fixture([
    start(10),
    start(20, a),
    start(30, b),
    terminate(80, a),
    terminate(90, b),
    terminate(100),
    event("child-a", 15, { type: "child.link", caseId, childCaseId: a }),
    event("child-b", 16, { type: "child.link", caseId, childCaseId: b }),
  ]);
  return {
    ...data,
    cases: [...data.cases, { id: a, processId }, { id: b, processId }],
    stageInstances: [],
  };
}

export function incident(): ReplayInput {
  return fixture([
    start(),
    enter(),
    event("blocked-a", 20, {
      type: "stage.block",
      stageInstanceId: instance,
      interruptionId: "dependency",
    }),
    event("blocked-b", 25, {
      type: "stage.block",
      stageInstanceId: instance,
      interruptionId: "access",
    }),
    event("paused", 30, {
      type: "stage.pause",
      stageInstanceId: instance,
      interruptionId: "window",
    }),
    event("unblocked-a", 40, {
      type: "stage.unblock",
      stageInstanceId: instance,
      interruptionId: "dependency",
    }),
    event("unblocked-b", 45, {
      type: "stage.unblock",
      stageInstanceId: instance,
      interruptionId: "access",
    }),
    event("resumed", 50, {
      type: "stage.resume",
      stageInstanceId: instance,
      interruptionId: "window",
    }),
    exit(60),
    terminate(80),
  ]);
}

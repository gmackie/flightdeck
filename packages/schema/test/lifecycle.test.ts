import * as v from "valibot";
import { describe, expect, it } from "vitest";
import {
  checkAgainstDefinition,
  isSensitiveKey,
  LIFECYCLE_TRANSITIONS,
  LifecycleBatch,
  LifecycleEventV1,
  MAX_LIFECYCLE_BATCH,
  MAX_LIFECYCLE_DIMENSIONS,
  MAX_LIFECYCLE_RELATIONS,
  MIN_OCCURRED_AT,
  ProcessDefinitionV1,
  prohibitedKeys,
} from "../src/lifecycle";

const T = Date.UTC(2026, 9, 31, 12);

const caseEvent = {
  schemaVersion: 1,
  eventId: "evt_hiring_000001",
  processId: "hiring",
  processVersion: 3,
  type: "case.created",
  caseId: "application:8f2c",
  occurredAt: T,
  sourceSequence: 1,
};
const stageEvent = {
  ...caseEvent,
  eventId: "evt_hiring_000002",
  type: "stage.entered",
  stageId: "phone_screen",
  stageInstanceId: "si_01",
  sourceSequence: 2,
};

const ok = (input: unknown) => v.safeParse(LifecycleEventV1, input).success;

describe("LifecycleEventV1", () => {
  it("accepts every typed transition in its required shape", () => {
    for (const type of LIFECYCLE_TRANSITIONS) {
      const event = type.startsWith("case.")
        ? { ...caseEvent, type }
        : type.startsWith("stage.")
          ? { ...stageEvent, type }
          : type.startsWith("object.")
            ? { ...caseEvent, type, object: { type: "requisition", objectId: "req-7" } }
            : {
                ...caseEvent,
                type,
                correction: { targetEventId: stageEvent.eventId, action: "retract" },
              };
      expect(ok(event), type).toBe(true);
    }
  });

  it("accepts optional source, reason, relations and dimensions", () => {
    const out = v.parse(LifecycleEventV1, {
      ...stageEvent,
      type: "stage.blocked",
      source: "greenhouse",
      reason: "awaiting_approval",
      relations: [{ type: "for_role", objectType: "requisition", objectId: "req-7" }],
      dimensions: { department: "eng", remote: true },
    });
    expect(out.dimensions).toEqual({ department: "eng", remote: true });
  });

  it("fails closed on unknown or missing schema versions", () => {
    expect(ok({ ...caseEvent, schemaVersion: 2 })).toBe(false);
    expect(ok({ ...caseEvent, schemaVersion: "1" })).toBe(false);
    const { schemaVersion: _, ...unversioned } = caseEvent;
    expect(ok(unversioned)).toBe(false);
  });

  it("rejects unknown transitions and unknown fields", () => {
    expect(ok({ ...caseEvent, type: "case.archived" })).toBe(false);
    expect(ok({ ...caseEvent, props: { plan: "pro" } })).toBe(false);
    expect(ok({ ...caseEvent, appId: "app_other" })).toBe(false);
    expect(ok({ ...caseEvent, email: "a@example.com" })).toBe(false);
  });

  it("requires stage ids on stage events and forbids them on case events", () => {
    const { stageInstanceId: _, ...noInstance } = stageEvent;
    expect(ok(noInstance)).toBe(false);
    expect(ok({ ...caseEvent, stageId: "phone_screen", stageInstanceId: "si_01" })).toBe(false);
  });

  it("requires the object on link events, and both stage ids or neither", () => {
    expect(ok({ ...caseEvent, type: "object.linked" })).toBe(false);
    const linked = { ...caseEvent, type: "object.linked", object: { type: "pr", objectId: "42" } };
    expect(ok(linked)).toBe(true);
    expect(ok({ ...linked, stageId: "review" })).toBe(false);
    expect(ok({ ...linked, stageId: "review", stageInstanceId: "si_9" })).toBe(true);
  });

  it("validates corrections", () => {
    const corrected = { ...caseEvent, type: "event.corrected" };
    const correction = (c: object) => ok({ ...corrected, correction: c });
    expect(ok(corrected)).toBe(false);
    expect(correction({ targetEventId: stageEvent.eventId, action: "amend" })).toBe(false);
    expect(correction({ targetEventId: stageEvent.eventId, action: "amend", occurredAt: T })).toBe(
      true,
    );
    expect(
      correction({ targetEventId: stageEvent.eventId, action: "retract", occurredAt: T }),
    ).toBe(false);
    expect(correction({ targetEventId: caseEvent.eventId, action: "retract" })).toBe(false);
    expect(
      correction({
        targetEventId: stageEvent.eventId,
        action: "amend",
        dimensions: { candidate_email: "x" },
      }),
    ).toBe(false);
  });

  it("keeps old occurredAt values but rejects seconds and non-integers", () => {
    expect(ok({ ...caseEvent, occurredAt: Date.UTC(2003, 0, 1) })).toBe(true);
    expect(ok({ ...caseEvent, occurredAt: MIN_OCCURRED_AT - 1 })).toBe(false);
    expect(ok({ ...caseEvent, occurredAt: Math.floor(T / 1000) })).toBe(false);
    expect(ok({ ...caseEvent, occurredAt: T + 0.5 })).toBe(false);
  });

  it("bounds ids, sequence and process version", () => {
    expect(ok({ ...caseEvent, eventId: "short" })).toBe(false);
    expect(ok({ ...caseEvent, caseId: "jane@example.com" })).toBe(false);
    expect(ok({ ...caseEvent, caseId: "x".repeat(129) })).toBe(false);
    expect(ok({ ...caseEvent, processId: "Hiring Pipeline" })).toBe(false);
    expect(ok({ ...caseEvent, sourceSequence: -1 })).toBe(false);
    expect(ok({ ...caseEvent, sourceSequence: Number.MAX_SAFE_INTEGER + 1 })).toBe(false);
    expect(ok({ ...caseEvent, processVersion: 0 })).toBe(false);
  });

  it("bounds dimensions to short codes and booleans", () => {
    const dims = (d: unknown) => ok({ ...caseEvent, dimensions: d });
    expect(dims({ seniority: "senior" })).toBe(true);
    expect(dims({ seniority: "Senior engineer, NYC" })).toBe(false);
    expect(dims({ score: 4 })).toBe(false);
    expect(dims({ level: null })).toBe(false);
    expect(dims({ Level: "l4" })).toBe(false);
    const many = Object.fromEntries(
      Array.from({ length: MAX_LIFECYCLE_DIMENSIONS + 1 }, (_, i) => [`d${i}`, "x"]),
    );
    expect(dims(many)).toBe(false);
  });

  it("rejects dimensions keyed by personal data", () => {
    for (const key of ["email", "candidate_email", "phone", "first_name", "ip_address", "ssn"]) {
      expect(ok({ ...caseEvent, dimensions: { [key]: "x" } }), key).toBe(false);
    }
  });

  it("bounds and dedupes relations", () => {
    const rel = { type: "for_role", objectType: "requisition", objectId: "req-7" };
    expect(ok({ ...caseEvent, relations: [rel, rel] })).toBe(false);
    const many = Array.from({ length: MAX_LIFECYCLE_RELATIONS + 1 }, (_, i) => ({
      ...rel,
      objectId: `req-${i}`,
    }));
    expect(ok({ ...caseEvent, relations: many })).toBe(false);
    expect(ok({ ...caseEvent, relations: [{ ...rel, extra: 1 }] })).toBe(false);
  });
});

describe("sensitive keys", () => {
  it("matches personal-data segments in any key style", () => {
    for (const key of ["email", "e_mail", "firstName", "api_key", "API-Key", "user.password"]) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
    for (const key of ["department", "seniority", "region", "zip_region", "tier", "remote"]) {
      expect(isSensitiveKey(key), key).toBe(false);
    }
  });

  it("finds prohibited keys anywhere in a payload", () => {
    expect(prohibitedKeys({ ...caseEvent })).toEqual([]);
    expect(prohibitedKeys({ ...caseEvent, meta: { contact: { phone: "1" } } })).toEqual(["phone"]);
    expect(prohibitedKeys([{ email: 1 }, { ok: 2 }])).toEqual(["email"]);
  });
});

describe("LifecycleBatch", () => {
  it("accepts only an events array of bounded size", () => {
    expect(v.safeParse(LifecycleBatch, { events: [caseEvent] }).success).toBe(true);
    expect(v.safeParse(LifecycleBatch, { events: [] }).success).toBe(false);
    const big = Array(MAX_LIFECYCLE_BATCH + 1).fill(caseEvent);
    expect(v.safeParse(LifecycleBatch, { events: big }).success).toBe(false);
    for (const extra of [{ appId: "app_x" }, { accessJwt: "jwt" }, { context: {} }]) {
      expect(v.safeParse(LifecycleBatch, { events: [caseEvent], ...extra }).success).toBe(false);
    }
  });
});

const definition = {
  schemaVersion: 1,
  processId: "hiring",
  version: 3,
  name: "Hiring",
  caseType: "job_application",
  stages: [
    { stageId: "applied", name: "Applied" },
    { stageId: "phone_screen", name: "Phone screen" },
    { stageId: "hired", name: "Hired", terminal: true },
  ],
  dimensions: [{ key: "department", values: ["eng", "sales"] }],
  relations: [{ type: "for_role", objectType: "requisition" }],
};

describe("ProcessDefinitionV1", () => {
  it("accepts a well-formed definition", () => {
    expect(v.safeParse(ProcessDefinitionV1, definition).success).toBe(true);
  });

  it("fails closed on unknown versions, duplicate ids and sensitive dimensions", () => {
    const bad = (over: object) => v.safeParse(ProcessDefinitionV1, { ...definition, ...over });
    expect(bad({ schemaVersion: 2 }).success).toBe(false);
    expect(bad({ stages: [] }).success).toBe(false);
    expect(bad({ stages: [definition.stages[0], definition.stages[0]] }).success).toBe(false);
    expect(bad({ dimensions: [{ key: "email", values: ["x"] }] }).success).toBe(false);
    expect(bad({ dimensions: [{ key: "dept", values: ["a", "a"] }] }).success).toBe(false);
    expect(bad({ owner: "jane" }).success).toBe(false);
  });

  it("checks events against the definition", () => {
    const def = v.parse(ProcessDefinitionV1, definition);
    const parse = (e: object) => v.parse(LifecycleEventV1, e);
    expect(checkAgainstDefinition(parse(stageEvent), def)).toEqual([]);
    expect(checkAgainstDefinition(parse({ ...stageEvent, stageId: "onsite" }), def)).toEqual([
      "unknown stage onsite",
    ]);
    expect(
      checkAgainstDefinition(
        parse({ ...caseEvent, dimensions: { department: "hr", x: "y" } }),
        def,
      ),
    ).toEqual(["value not allowed for dimension department", "unknown dimension x"]);
    expect(checkAgainstDefinition(parse({ ...caseEvent, processVersion: 2 }), def)).toEqual([
      "event is for hiring@2",
    ]);
    expect(
      checkAgainstDefinition(
        parse({ ...caseEvent, type: "object.linked", object: { type: "offer", objectId: "o1" } }),
        def,
      ),
    ).toEqual(["object type offer not allowed"]);
  });
});

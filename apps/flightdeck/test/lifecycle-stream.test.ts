import type { LifecycleRecord } from "@flightdeckhq/schema";
import { describe, expect, it, vi } from "vitest";
import lifecycle from "../pipelines/lifecycle_events.schema.json";
import { LIFECYCLE_FIELDS, sinks, streamProblems, streamRow } from "../src/sinks";
import { T0 } from "./fixtures";

// Every nullable column null, so `required` must equal `value !== null` for each field.
const sparse: LifecycleRecord = {
  event_id: "evt_000000001",
  app_id: "app_test",
  schema_version: 1,
  process_id: "hiring",
  process_version: 2,
  type: "case.created",
  case_id: "application:1",
  stage_id: null,
  stage_instance_id: null,
  occurred_at: T0,
  received_at: T0 + 5,
  source: null,
  source_sequence: 1,
  reason: null,
  object_type: null,
  object_id: null,
  relations: null,
  dimensions: null,
  corrects_event_id: null,
  correction: null,
  channel: "http",
};

// Every nullable column filled.
const full: LifecycleRecord = {
  ...sparse,
  type: "event.corrected",
  stage_id: "phone_screen",
  stage_instance_id: "si_1",
  source: "greenhouse",
  source_sequence: Number.MAX_SAFE_INTEGER,
  reason: "data_entry_error",
  object_type: "requisition",
  object_id: "req-7",
  relations: [{ type: "for_role", object_type: "requisition", object_id: "req-7" }],
  dimensions: { department: "eng", remote: true },
  corrects_event_id: "evt_000000000",
  correction: { action: "amend", occurred_at: T0 - 1, dimensions: { department: "sales" } },
};

const env = (send?: (rows: unknown[]) => Promise<void>) =>
  (send ? { LIFECYCLE_EVENTS: { send } } : {}) as unknown as Env;

describe("lifecycle_events stream schema", () => {
  it("has exactly the record's columns, in order", () => {
    expect(lifecycle.fields.map((f) => f.name)).toEqual(Object.keys(sparse));
  });

  it("marks exactly the nullable columns as not required", () => {
    for (const f of lifecycle.fields) {
      expect(f.required, f.name).toBe((sparse as Record<string, unknown>)[f.name] !== null);
    }
  });

  it("accepts sparse and full records on the wire", () => {
    expect(streamProblems(LIFECYCLE_FIELDS, streamRow(sparse))).toEqual([]);
    expect(streamProblems(LIFECYCLE_FIELDS, streamRow(full))).toEqual([]);
  });

  it("stores epoch-ms numbers as millisecond timestamps", () => {
    for (const f of lifecycle.fields.filter((f) => f.type === "timestamp")) {
      expect((f as { unit?: string }).unit, f.name).toBe("millisecond");
    }
  });

  it("flags rows Basin would drop: missing, mistyped and unknown columns", () => {
    const { case_id: _, ...missing } = streamRow(sparse);
    expect(streamProblems(LIFECYCLE_FIELDS, missing)).toEqual(["case_id: required"]);
    const wrong = { ...streamRow(sparse), source_sequence: "1", dimensions: [1], extra: 1 };
    expect(streamProblems(LIFECYCLE_FIELDS, wrong)).toEqual([
      "extra: not in schema",
      "source_sequence: expected int64",
      "dimensions: expected JSON object",
    ]);
    const relation = { ...streamRow(sparse), relations: [{ type: "x", object_type: "y" }] };
    expect(streamProblems(LIFECYCLE_FIELDS, relation)).toEqual(["relations: object_id: required"]);
  });
});

describe("sinks.lifecycle", () => {
  it("sends wire rows to LIFECYCLE_EVENTS, omitting null columns", async () => {
    const send = vi.fn(async (_rows: unknown[]) => {});
    await sinks.lifecycle(env(send), [sparse]);
    expect(send.mock.calls[0]?.[0]).toEqual([streamRow(sparse)]);
    expect(send.mock.calls[0]?.[0][0]).not.toHaveProperty("stage_id");
  });

  it("refuses rows that break the stream schema instead of letting Basin drop them", async () => {
    const send = vi.fn(async (_rows: unknown[]) => {});
    const bad = { ...sparse, process_version: 1.5 };
    await expect(sinks.lifecycle(env(send), [bad])).rejects.toThrow(/process_version/);
    expect(send).not.toHaveBeenCalled();
  });

  it("fails as unavailable when the binding is absent", async () => {
    await expect(sinks.lifecycle(env(), [sparse])).rejects.toThrow(/^lifecycle unavailable/);
  });
});

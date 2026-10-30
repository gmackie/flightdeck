import type { SessionRecord, StoredEvent } from "@flightdeckhq/schema";
import { describe, expect, it } from "vitest";
import events from "../pipelines/events.schema.json";
import sessions from "../pipelines/sessions.schema.json";
import { row, sid, T0 } from "./fixtures";

type Field = { name: string; type: string; required: boolean; unit?: string };

// Every nullable column is null here, so the required check below covers all of them.
const event: StoredEvent = row({
  session_id: null,
  anonymous_id: null,
  user_id: null,
  path: null,
  referrer: null,
  props: null,
  country: null,
});

const session: SessionRecord = {
  session_id: sid("a"),
  app_id: "app_test",
  anonymous_id: null,
  user_id: null,
  started_at: T0,
  ended_at: T0 + 1_000,
  duration_ms: 1_000,
  entry: null,
  exit: null,
  steps: [],
  step_count: 0,
  event_count: 1,
  country: null,
  device: "desktop",
};

describe.each([
  ["events", events.fields as Field[], event as Record<string, unknown>],
  ["sessions", sessions.fields as Field[], session as Record<string, unknown>],
])("%s stream schema", (_name, fields, sample) => {
  it("has exactly the record's columns, in order", () => {
    expect(fields.map((f) => f.name)).toEqual(Object.keys(sample));
  });

  it("marks nullable columns as not required", () => {
    for (const f of fields) {
      if (sample[f.name] === null) expect(f.required, f.name).toBe(false);
    }
  });

  it("stores epoch-ms numbers as millisecond timestamps", () => {
    for (const f of fields.filter((f) => f.type === "timestamp")) {
      expect(f.unit, f.name).toBe("millisecond");
      expect(typeof sample[f.name], f.name).toBe("number");
    }
  });
});

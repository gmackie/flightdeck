import type { SessionRecord, StoredEvent } from "@flightdeckhq/schema";
import { describe, expect, it } from "vitest";
import events from "../pipelines/events.schema.json";
import sessions from "../pipelines/sessions.schema.json";
import { row, sid, T0 } from "./fixtures";

type Field = { name: string; type: string; required: boolean; unit?: string; items?: Field };

// Every nullable column is null and every required column is non-null, so `required` must equal
// `value !== null` for each field.
const event: StoredEvent = row({
  session_id: null,
  anonymous_id: null,
  user_id: null,
  path: null,
  referrer: null,
  props: null,
  country: null,
});

// The same rows with every nullable column filled, for the type check.
const fullEvent: StoredEvent = row({
  user_id: "user-1",
  referrer: "https://search.example",
  props: { plan: "pro", seats: 3, trial: false, coupon: null },
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
  steps: ["/"],
  step_count: 1,
  event_count: 1,
  country: null,
  device: "desktop",
};

const NUMBER_TYPES = new Set(["int32", "int64", "timestamp", "float64"]);

function compatible(f: Field, value: unknown): boolean {
  if (typeof value === "string") return f.type === "string";
  if (typeof value === "number") {
    if (!NUMBER_TYPES.has(f.type)) return false;
    return f.type === "float64" || Number.isInteger(value);
  }
  if (typeof value === "boolean") return f.type === "bool";
  if (Array.isArray(value)) {
    return f.type === "list" && !!f.items && value.every((v) => compatible(f.items as Field, v));
  }
  if (typeof value === "object") return f.type === "json";
  return false;
}

const fullSession: SessionRecord = {
  ...session,
  anonymous_id: sid("z"),
  user_id: "user-1",
  entry: "/",
  exit: "/",
  country: "US",
};

type Row = Record<string, unknown>;

describe.each([
  ["events", events.fields as Field[], event as Row, fullEvent as Row],
  ["sessions", sessions.fields as Field[], session as Row, fullSession as Row],
])("%s stream schema", (_name, fields, sample, full) => {
  it("has exactly the record's columns, in order", () => {
    expect(fields.map((f) => f.name)).toEqual(Object.keys(sample));
  });

  it("marks exactly the nullable columns as not required", () => {
    for (const f of fields) expect(f.required, f.name).toBe(sample[f.name] !== null);
  });

  it("uses a column type compatible with each value", () => {
    for (const f of fields) {
      const value = full[f.name];
      expect(value, f.name).not.toBeNull();
      expect(compatible(f, value), `${f.name}: ${f.type} vs ${JSON.stringify(value)}`).toBe(true);
    }
  });

  it("stores epoch-ms numbers as millisecond timestamps", () => {
    for (const f of fields.filter((f) => f.type === "timestamp")) {
      expect(f.unit, f.name).toBe("millisecond");
      expect(typeof sample[f.name], f.name).toBe("number");
    }
  });
});

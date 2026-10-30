import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { ClientEvent, IngestBatch, MAX_BATCH } from "../src/events";

const event = {
  kind: "click",
  name: "pricing.cta",
  ts: 1_793_000_000_000,
  sessionId: "s".repeat(32),
};

const ok = (input: unknown) => v.safeParse(ClientEvent, input).success;

describe("IngestBatch", () => {
  it("accepts a well-formed batch", () => {
    expect(v.safeParse(IngestBatch, { events: [event] }).success).toBe(true);
  });

  it("rejects empty and oversized batches", () => {
    expect(v.safeParse(IngestBatch, { events: [] }).success).toBe(false);
    expect(v.safeParse(IngestBatch, { events: Array(MAX_BATCH + 1).fill(event) }).success).toBe(
      false,
    );
  });

  it("validates only the envelope, so one bad event does not reject the batch", () => {
    const batch = { events: [event, { ...event, kind: "scroll" }] };
    expect(v.safeParse(IngestBatch, batch).success).toBe(true);
  });
});

describe("ClientEvent", () => {
  it("accepts a 32-hex browser id and a track event with no sessionId", () => {
    const hex = "0b6f8d0e6c1e4a599a436f1f0f6c2b11"; // crypto.randomUUID() without dashes
    expect(ok({ ...event, anonymousId: hex, sessionId: hex })).toBe(true);
    expect(ok({ kind: "track", name: "signup", ts: event.ts })).toBe(true);
  });

  it("truncates long paths and names instead of rejecting", () => {
    const out = v.parse(ClientEvent, {
      ...event,
      path: `/${"a".repeat(2999)}`,
      name: "n".repeat(300),
    });
    expect(out.path).toHaveLength(2048);
    expect(out.name).toHaveLength(256);
  });

  it("rejects an empty name", () => {
    expect(ok({ ...event, name: "" })).toBe(false);
  });

  it("accepts null for optional identity fields", () => {
    expect(ok({ ...event, userId: null, referrer: null, props: null })).toBe(true);
  });

  it("rejects non-finite numbers and empty keys in props", () => {
    expect(ok({ ...event, props: { n: Infinity } })).toBe(false);
    expect(ok({ ...event, props: { "": 1 } })).toBe(false);
  });

  it("requires userId on identify", () => {
    expect(ok({ ...event, kind: "identify", name: "identify" })).toBe(false);
    expect(ok({ ...event, kind: "identify", name: "identify", userId: "u_1" })).toBe(true);
  });

  it("rejects ts above the max Date value", () => {
    expect(ok({ ...event, ts: 8_640_000_000_000_001 })).toBe(false);
  });

  it("rejects more than 32 props", () => {
    const props = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, i]));
    expect(ok({ ...event, props })).toBe(false);
  });

  it("accepts an optional client eventId with the id rule", () => {
    expect(v.parse(ClientEvent, { ...event, eventId: "01JBX9ZP8Q6M2K4T7V3W5Y1A0C" }).eventId).toBe(
      "01JBX9ZP8Q6M2K4T7V3W5Y1A0C",
    );
    expect(ok({ ...event, eventId: null })).toBe(true);
    expect(ok({ ...event, eventId: "short" })).toBe(false);
    expect(ok({ ...event, eventId: "e".repeat(65) })).toBe(false);
    expect(ok({ ...event, eventId: "bad id!!" })).toBe(false);
  });

  it("rejects malformed ids and unknown kinds", () => {
    expect(ok({ ...event, sessionId: "bad id!" })).toBe(false);
    expect(ok({ ...event, kind: "scroll" })).toBe(false);
  });
});

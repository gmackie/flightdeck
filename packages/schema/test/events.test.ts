import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { IngestBatch, MAX_BATCH } from "../src/events";

const event = {
  kind: "click",
  name: "pricing.cta",
  ts: 1_793_000_000_000,
  sessionId: "s".repeat(32),
};

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

  it("rejects more than 32 props", () => {
    const props = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, i]));
    expect(v.safeParse(IngestBatch, { events: [{ ...event, props }] }).success).toBe(false);
  });

  it("rejects malformed ids and unknown kinds", () => {
    expect(v.safeParse(IngestBatch, { events: [{ ...event, sessionId: "bad id!" }] }).success).toBe(
      false,
    );
    expect(v.safeParse(IngestBatch, { events: [{ ...event, kind: "scroll" }] }).success).toBe(
      false,
    );
  });
});

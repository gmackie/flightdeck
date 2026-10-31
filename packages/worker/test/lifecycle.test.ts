import { describe, expect, it, vi } from "vitest";
import { flightdeckLifecycle, isPermanentLifecycleError } from "../src";

describe("flightdeckLifecycle", () => {
  it("returns the binding's lifecycle methods without swallowing errors", async () => {
    const trackLifecycle = vi.fn(async () => ({ accepted: 1 }));
    const ingestLifecycleBatch = vi.fn(async () => {
      throw new Error("lifecycle unavailable: LIFECYCLE_EVENTS is not bound");
    });
    const env = { FLIGHTDECK: { trackLifecycle, ingestLifecycleBatch } };
    const lifecycle = flightdeckLifecycle(env);
    expect(await lifecycle.trackLifecycle({ eventId: "evt_00000001" })).toEqual({ accepted: 1 });
    await expect(lifecycle.ingestLifecycleBatch({ events: [] })).rejects.toThrow(/unavailable/);
    expect(flightdeckLifecycle({ FD: env.FLIGHTDECK }, { binding: "FD" })).toBe(env.FLIGHTDECK);
  });

  it("throws a clear error when the binding is missing", () => {
    expect(() => flightdeckLifecycle({})).toThrow(/env\.FLIGHTDECK service binding is missing/);
  });
});

describe("isPermanentLifecycleError", () => {
  it("separates permanent rejections from retryable failures", () => {
    expect(isPermanentLifecycleError(new Error("lifecycle rejected (invalid_event): x"))).toBe(
      true,
    );
    for (const message of [
      "lifecycle unavailable: LIFECYCLE_EVENTS is not bound",
      "lifecycle forbidden: lifecycle.write is not granted",
      "Network connection lost.",
      "lifecycle rejected (future_occurred_at) at events[0]: occurredAt is ahead of the server clock",
    ]) {
      expect(isPermanentLifecycleError(new Error(message)), message).toBe(false);
    }
    expect(isPermanentLifecycleError("lifecycle rejected")).toBe(false);
  });
});

import { Effect } from "effect";
import type { AnalyticsEvent } from "@flightdeck/contracts";
import { Flightdeck, type TrackOptions } from "@flightdeck/sdk-worker";

export class FlightdeckDeliveryError extends Error {
  readonly _tag = "FlightdeckDeliveryError";
  constructor(cause: unknown) { super("Flightdeck delivery failed", { cause }); }
}
/** Compose with Effect request handlers; caller decides whether failure aborts business logic. */
export function effectFlightdeck(client: Flightdeck) {
  return {
    track: (name: string, properties: Record<string, unknown> = {}, options?: TrackOptions) =>
      Effect.tryPromise({ try: () => client.track(name, properties, options), catch: (cause) => new FlightdeckDeliveryError(cause) }),
    batch: (events: readonly AnalyticsEvent[]) =>
      Effect.tryPromise({ try: () => client.batch(events), catch: (cause) => new FlightdeckDeliveryError(cause) }),
  };
}

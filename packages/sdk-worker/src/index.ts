import type { AnalyticsBinding, AnalyticsEvent, CaptureReceipt, ObjectRef } from "@flightdeck/contracts";

export type TrackOptions = {
  eventId?: string; occurredAt?: string; anonymousId?: string; actorId?: string;
  sessionId?: string; pageViewId?: string; interactionId?: string; traceId?: string;
  objects?: ObjectRef[];
};
export type FlightdeckOptions = {
  binding: AnalyticsBinding;
  sourceId: string;
  sourceToken: string;
  environment?: string;
  defaults?: () => Partial<TrackOptions>;
};
export class Flightdeck {
  constructor(private readonly options: FlightdeckOptions) {}
  async track(name: string, properties: Record<string, unknown> = {}, opts: TrackOptions = {}): Promise<CaptureReceipt> {
    const d = { ...this.options.defaults?.(), ...opts };
    const event: AnalyticsEvent = {
      eventId: d.eventId ?? crypto.randomUUID(), eventName: name,
      occurredAt: d.occurredAt ?? new Date().toISOString(),
      objects: d.objects ?? [], properties: properties as AnalyticsEvent["properties"],
      ...(d.actorId ? { actorId: d.actorId } : {}),
      ...(d.anonymousId ? { anonymousId: d.anonymousId } : {}),
      ...(d.sessionId ? { sessionId: d.sessionId } : {}),
      ...(d.pageViewId ? { pageViewId: d.pageViewId } : {}),
      ...(d.interactionId ? { interactionId: d.interactionId } : {}),
      ...(d.traceId ? { traceId: d.traceId } : {}),
    };
    return this.batch([event]);
  }
  async batch(events: readonly AnalyticsEvent[]): Promise<CaptureReceipt> {
    return this.options.binding.captureBatch({
      context: { sourceId: this.options.sourceId, sourceToken: this.options.sourceToken, environment: this.options.environment },
      events,
    });
  }
  async identify(actorId: string, properties: Record<string, unknown> = {}): Promise<CaptureReceipt> {
    return this.track("identity.identified", properties, { actorId });
  }
  async expose(flagKey: string, variant: string, opts: TrackOptions = {}): Promise<CaptureReceipt> {
    return this.track("feature.exposed", { flagKey, variant }, opts);
  }
}
export function createFlightdeck(options: FlightdeckOptions): Flightdeck { return new Flightdeck(options); }

import type {
  AnalyticsBinding, AnalyticsEvent, CaptureReceipt, EventKind, ObjectReference, GraphReceipt
} from "@flightdeck/contracts";
import type {GraphManifest} from "@flightdeck/knowledge";

export type TrackOptions = {
  eventId?: string; occurredAt?: string; kind?: EventKind;
  anonymousId?: string; actorId?: string; sessionId?: string; pageViewId?: string;
  interactionId?: string; traceId?: string; deploymentId?: string;
  objects?: readonly ObjectReference[];
};
export interface FlightdeckOptions {
  binding: AnalyticsBinding;
  sourceId: string;
  sourceToken: string;
  environment?: string;
  consentGranted?: boolean | (() => boolean);
  defaults?: () => TrackOptions;
}
export class Flightdeck {
  constructor(private readonly options: FlightdeckOptions) {}
  withConsent(consentGranted:boolean):Flightdeck {
    return new Flightdeck({...this.options,consentGranted});
  }
  withContext(context: TrackOptions): Flightdeck {
    const { defaults, ...rest } = this.options;
    return new Flightdeck({ ...rest, defaults: () => ({...defaults?.(), ...context}) });
  }
  track(
    name: string, properties: Record<string, unknown> = {}, options: TrackOptions = {}
  ): Promise<CaptureReceipt> {
    const defaults = { ...this.options.defaults?.(), ...options };
    const event: AnalyticsEvent = {
      eventId: defaults.eventId ?? crypto.randomUUID(),
      eventName: name, occurredAt: defaults.occurredAt ?? new Date().toISOString(),
      objects: [...(defaults.objects ?? [])],
      properties: properties as AnalyticsEvent["properties"],
      ...(defaults.kind ? {kind:defaults.kind} : {}),
      ...(defaults.actorId ? {actorId:defaults.actorId} : {}),
      ...(defaults.anonymousId ? {anonymousId:defaults.anonymousId} : {}),
      ...(defaults.sessionId ? {sessionId:defaults.sessionId} : {}),
      ...(defaults.pageViewId ? {pageViewId:defaults.pageViewId} : {}),
      ...(defaults.interactionId ? {interactionId:defaults.interactionId} : {}),
      ...(defaults.traceId ? {traceId:defaults.traceId} : {}),
      ...(defaults.deploymentId ? {deploymentId:defaults.deploymentId} : {}),
    };
    return this.batch([event]);
  }
  batch(events: readonly AnalyticsEvent[]): Promise<CaptureReceipt> {
    return this.options.binding.captureBatch({
      context: {
        sourceId: this.options.sourceId,
        sourceToken: this.options.sourceToken,
        ...(this.options.environment ? {environment:this.options.environment}:{}),
        ...(this.options.consentGranted !== undefined
          ? {consentGranted: typeof this.options.consentGranted === "function"
              ? this.options.consentGranted() : this.options.consentGranted}
          : {}),
      }, events,
    });
  }
  /** Send a full, versioned architecture manifest from a trusted application Worker. */
  registerGraph(manifest:GraphManifest):Promise<GraphReceipt>{
    const rpc=this.options.binding.registerGraph;
    if(!rpc)throw new Error("Flightdeck core does not support graph registration");
    return rpc({
      context:{
        sourceId:this.options.sourceId,sourceToken:this.options.sourceToken,
        ...(this.options.environment?{environment:this.options.environment}:{})
      },
      manifest,
    });
  }
  identify(actorId: string, properties:Record<string,unknown>={}): Promise<CaptureReceipt> {
    return this.track("identity.identified",properties,{actorId});
  }
  expose(flagKey:string,variant:string,options:TrackOptions & {experimentId?:string}={}): Promise<CaptureReceipt> {
    return this.track("feature.exposed",
      {flagKey,variant,...(options.experimentId?{experimentId:options.experimentId}:{})},
      {...options,kind:"exposure"});
  }
  /** Explicit best effort; do not use as a substitute for a transactional business outbox. */
  trackLater(
    ctx: { waitUntil(promise: Promise<unknown>): void },
    eventName: string, properties:Record<string,unknown>={}, options:TrackOptions={},
    onError:(error:unknown)=>void = console.error
  ):void {
    ctx.waitUntil(this.track(eventName,properties,options).then(()=>{},onError));
  }
}
export function createFlightdeck(options:FlightdeckOptions):Flightdeck {
  return new Flightdeck(options);
}

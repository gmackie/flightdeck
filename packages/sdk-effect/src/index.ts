import { Effect } from "effect";
import type { AnalyticsEvent } from "@flightdeck/contracts";
import { Flightdeck, type TrackOptions } from "@flightdeck/sdk-worker";

export class FlightdeckDeliveryError extends Error {
  readonly _tag="FlightdeckDeliveryError";
  constructor(cause:unknown){super("Flightdeck delivery failed",{cause});}
}
/** Wraps Worker service-binding RPC in typed Effect failure channels. */
export function effectFlightdeck(client: Flightdeck){
  return {
    track:(event:string,properties:Record<string,unknown>={},context:TrackOptions={})=>
      Effect.tryPromise({try:()=>client.track(event,properties,context),catch:err=>new FlightdeckDeliveryError(err)}),
    batch:(events:readonly AnalyticsEvent[])=>
      Effect.tryPromise({try:()=>client.batch(events),catch:err=>new FlightdeckDeliveryError(err)}),
    identify:(actorId:string,properties:Record<string,unknown>={})=>
      Effect.tryPromise({try:()=>client.identify(actorId,properties),catch:err=>new FlightdeckDeliveryError(err)}),
    expose:(flagKey:string,variant:string,context:TrackOptions={})=>
      Effect.tryPromise({try:()=>client.expose(flagKey,variant,context),catch:err=>new FlightdeckDeliveryError(err)}),
  };
}

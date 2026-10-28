import type { AnalyticsEvent, EventKind, ObjectReference } from "@flightdeck/contracts";
import { Flightdeck } from "./index";

export type AuthenticatedActor = {id:string};
export type BrowserEventPolicy = {
  /** Exact event names only; unknown names are rejected. */
  events: Record<string,{ properties: readonly string[]; kind?: EventKind }>;
  /** Explicit permitted origins, including protocol; avoids cookie-authenticated CSRF. */
  origins: readonly string[];
  /** Default 64 KiB. */
  maxBytes?: number;
};
export interface BrowserHandlerOptions<T extends AuthenticatedActor> {
  authenticate(request:Request): Promise<T|null>;
  client(actor:T, request:Request): Flightdeck;
  policy: BrowserEventPolicy;
  objects?(actor:T, eventName:string): readonly ObjectReference[];
}
function json(body:unknown,status=200):Response {
  return Response.json(body,{status,headers:{"Cache-Control":"no-store"}});
}
type UntrustedEvent={
  eventId?:unknown; eventName?:unknown; occurredAt?:unknown;
  anonymousId?:unknown; sessionId?:unknown; pageViewId?:unknown; interactionId?:unknown;
  properties?:unknown;
};
/** Use from an application Worker after its own auth and rate limiting are configured. */
export function createBrowserEventHandler<T extends AuthenticatedActor>(
  options:BrowserHandlerOptions<T>
):(request:Request)=>Promise<Response> {
  return async (request) => {
    if (request.method!=="POST") return json({error:"method_not_allowed"},405);
    const origin=request.headers.get("Origin");
    if(!origin || !options.policy.origins.includes(origin)) return json({error:"origin_not_allowed"},403);
    if(!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json"))
      return json({error:"content_type"},415);
    const declared=Number(request.headers.get("Content-Length")??"0");
    const max=options.policy.maxBytes??65_536;
    if(Number.isFinite(declared) && declared>max) return json({error:"batch_too_large"},413);
    const actor=await options.authenticate(request);
    if(!actor || !actor.id) return json({error:"unauthorized"},401);
    let raw:string;try{raw=await request.text();}catch{return json({error:"invalid_body"},400);}
    if(new TextEncoder().encode(raw).byteLength>max) return json({error:"batch_too_large"},413);
    let payload:unknown;
    try {payload=JSON.parse(raw);}catch{return json({error:"invalid_json"},400);}
    if(!payload || typeof payload!=="object" || !("events" in payload) ||
      !Array.isArray(payload.events) || payload.events.length<1 ||payload.events.length>100)
      return json({error:"invalid_batch"},400);
    const events:AnalyticsEvent[]=[];
    for(const raw of payload.events as UntrustedEvent[]){
      if(!raw || typeof raw!=="object" || typeof raw.eventName!=="string")
        return json({error:"invalid_event"},400);
      const setting=options.policy.events[raw.eventName];
      if(!Object.prototype.hasOwnProperty.call(options.policy.events,raw.eventName)||!setting)
        return json({error:"event_not_allowed"},403);
      const props=raw.properties??{};
      if(!props || typeof props!=="object" || Array.isArray(props))
        return json({error:"invalid_properties"},400);
      if(Object.keys(props).some(key=>!setting.properties.includes(key)))
        return json({error:"property_not_allowed"},400);
      const maybe=(v:unknown)=>typeof v==="string" && v.length<=128 ? v:undefined;
      events.push({
        eventId: maybe(raw.eventId)??crypto.randomUUID(),
        eventName:raw.eventName,
        occurredAt: maybe(raw.occurredAt)??new Date().toISOString(),
        actorId:actor.id, kind:setting.kind??"product",
        objects:[...(options.objects?.(actor,raw.eventName)??[])],
        properties: props as AnalyticsEvent["properties"],
        ...(maybe(raw.anonymousId)?{anonymousId:maybe(raw.anonymousId)}:{}),
        ...(maybe(raw.sessionId)?{sessionId:maybe(raw.sessionId)}:{}),
        ...(maybe(raw.pageViewId)?{pageViewId:maybe(raw.pageViewId)}:{}),
        ...(maybe(raw.interactionId)?{interactionId:maybe(raw.interactionId)}:{}),
      });
    }
    try {
      const receipt=await options.client(actor,request).batch(events);
      return json(receipt,202);
    } catch {
      return json({error:"ingestion_unavailable",retryable:true},503);
    }
  };
}

import type {AnalyticsEvent, CaptureReceipt} from "@flightdeck/contracts";

export interface DemoInput {runId:string; startedAt:string}
export interface DemoOptions {
  /** Explicit opt-in; never enable this on a customer-data collector. */
  enabled:boolean;
  token?:string;
  source:string;
  events:readonly string[];
  capture(events:readonly AnalyticsEvent[]):Promise<CaptureReceipt>;
}
/** Bounded synthetic fixtures, shared by the live verifier and consumer demos. */
export function demoEvents(source:string,names:readonly string[],input:DemoInput):AnalyticsEvent[]{
  return names.map((eventName,index)=>({
    eventId:`${input.runId}:${source}:${index}`,eventName,
    occurredAt:new Date(Date.parse(input.startedAt)+index*1000).toISOString(),
    actorId:`${source}:${input.runId}`,sessionId:`${source}:${input.runId}`,
    kind:"product",objects:[{type:"demo_run",id:input.runId,role:"subject"}],
    properties:{demo:true,stage:index},
  }));
}
/** App-owned demo endpoint. Accepts fixture IDs only, never arbitrary analytics. */
export function createDemoHandler(options:DemoOptions):(request:Request)=>Promise<Response>{
  const json=(body:object,status=200)=>Response.json(body,{status,headers:{"Cache-Control":"no-store"}});
  return async request=>{
    if(!options.enabled||!options.token||options.token.length<32)return json({error:"not_found"},404);
    if(request.headers.get("Authorization")!==`Bearer ${options.token}`)return json({error:"unauthorized"},401);
    if(request.method!=="POST")return json({error:"method_not_allowed"},405);
    if(request.headers.get("Content-Type")?.split(";")[0]?.trim()!=="application/json")return json({error:"content_type"},415);
    // Bound the stream even if Content-Length is absent or forged.
    const reader=request.body?.getReader();
    if(!reader)return json({error:"invalid_body"},400);
    let text="",size=0;const decoder=new TextDecoder();
    try{
      while(true){const {done,value}=await reader.read();if(done)break;
        size+=value.byteLength;if(size>1024){await reader.cancel();return json({error:"body_too_large"},413);}
        text+=decoder.decode(value,{stream:true});
      }
      text+=decoder.decode();
    }catch{return json({error:"invalid_body"},400);}
    let input:unknown;try{input=JSON.parse(text);}catch{return json({error:"invalid_json"},400);}
    if(!input||typeof input!=="object"||!("runId" in input)||!("startedAt" in input)||
      Object.keys(input).some(k=>k!=="runId"&&k!=="startedAt")||
      typeof input.runId!=="string"||!/^demo-[a-z0-9-]{1,40}$/.test(input.runId)||
      typeof input.startedAt!=="string"||!Number.isFinite(Date.parse(input.startedAt))||
      Math.abs(Date.now()-Date.parse(input.startedAt))>300_000)
      return json({error:"invalid_fixture"},400);
    const events=demoEvents(options.source,options.events,{runId:input.runId,startedAt:input.startedAt});
    try{
      const receipt=await options.capture(events);
      // Submit the same logical event once more to verify downstream deduplication.
      const retry=await options.capture([events[0]!]);
      return json({source:options.source,receipt,retry,eventIds:events.map(e=>e.eventId)},202);
    }catch{return json({error:"ingestion_unavailable"},503);}
  };
}

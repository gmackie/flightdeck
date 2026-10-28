import type { AnalyticsEvent, EventKind } from "@flightdeck/contracts";

export interface BrowserOptions {
  /** Same-origin endpoint on YOUR application Worker, not on Flightdeck. */
  endpoint?: string;
  /** The embedding app controls consent; no telemetry is sent unless true. */
  consent: () => boolean;
  batchSize?: number;
  intervalMs?: number;
  /** Inject fetch in tests, service workers or specialized runtimes. */
  send?: typeof fetch;
}
export type BrowserProperties = Record<string, unknown>;
export interface BrowserEventOptions { eventId?: string; kind?: EventKind; anonymousId?: string; interactionId?: string; }
function redactRoute(path:string):string {
  return path.split("?")[0]!.replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi,":id")
    .replace(/\/(\d+)(?=\/|$)/g,"/:id");
}
export class BrowserFlightdeck {
  private queue: AnalyticsEvent[]=[];
  private timer:ReturnType<typeof setInterval>|undefined;
  private inFlight:Promise<void>|undefined;
  private sessionId=crypto.randomUUID();
  private pageViewId=crypto.randomUUID();
  private stopped=false;
  readonly options: Required<Pick<BrowserOptions,"endpoint"|"batchSize"|"intervalMs">> & BrowserOptions;
  constructor(options:BrowserOptions) {
    this.options={endpoint:"/api/analytics",batchSize:25,intervalMs:5_000,...options};
    if(this.options.batchSize<1||this.options.batchSize>100)throw new Error("batchSize must be 1..100");
  }
  start():void {
    if(this.timer||this.stopped)return;
    this.timer=setInterval(()=>{void this.flush()},this.options.intervalMs);
    if(typeof window!=="undefined"){
      window.addEventListener("pagehide",this.onPageHide);
      window.addEventListener("online",this.onOnline);
    }
  }
  private onPageHide=()=>{void this.flush()};
  private onOnline=()=>{void this.flush()};
  track(name:string,properties:BrowserProperties={},options:BrowserEventOptions={}):string|null {
    if(this.stopped||!this.options.consent())return null;
    if(!/^[a-z][a-z0-9_.-]{0,127}$/.test(name))throw new Error("Invalid event name");
    const eventId=options.eventId??crypto.randomUUID();
    this.queue.push({
      eventId,eventName:name,occurredAt:new Date().toISOString(),
      kind:options.kind??"product",sessionId:this.sessionId,pageViewId:this.pageViewId,
      ...(options.anonymousId?{anonymousId:options.anonymousId}:{}),
      ...(options.interactionId?{interactionId:options.interactionId}:{}),
      objects:[], properties:properties as AnalyticsEvent["properties"],
    });
    if(this.queue.length>=this.options.batchSize)void this.flush();
    return eventId;
  }
  page(route?:string):string|null {
    this.pageViewId=crypto.randomUUID();
    const value=route??(typeof location!=="undefined"?location.pathname:"/");
    return this.track("page.viewed",{route:redactRoute(value)});
  }
  async flush():Promise<void>{
    if(this.inFlight)return this.inFlight;
    if(!this.options.consent()){this.queue=[];return;}
    if(!this.queue.length)return;
    const batch=this.queue.splice(0,this.options.batchSize);
    const sender=this.options.send??fetch;
    this.inFlight=(async()=>{
      try{
        const res=await sender(this.options.endpoint,{
          method:"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify({events:batch}),credentials:"same-origin",keepalive:true,
        });
        if(!res.ok)throw new Error("Flightdeck collector returned "+res.status);
      }catch(err){
        // Keep a bounded queue for later retry. Application authentication may have expired.
        this.queue.unshift(...batch);
        if(this.queue.length>500)this.queue.splice(500);
        throw err;
      }finally{this.inFlight=undefined;}
    })();
    return this.inFlight;
  }
  /** Web Vitals collection is opt-in and never observes form contents. */
  async enableWebVitals():Promise<void>{
    const {onLCP,onINP,onCLS,onTTFB}=await import("web-vitals");
    const report=(name:string)=>(metric:{value:number;rating:string;id:string})=>{
      this.track("rum."+name,{value:metric.value,rating:metric.rating,metricId:metric.id},{kind:"rum"});
    };
    onLCP(report("lcp"));onINP(report("inp"));onCLS(report("cls"));onTTFB(report("ttfb"));
  }
  async stop():Promise<void>{
    if(this.timer){clearInterval(this.timer);this.timer=undefined;}
    if(typeof window!=="undefined"){
      window.removeEventListener("pagehide",this.onPageHide);
      window.removeEventListener("online",this.onOnline);
    }
    await this.flush();
    this.stopped=true;
  }
  /** Erase unsent events when consent is withdrawn or a user logs out. */
  reset():void {this.queue=[];this.sessionId=crypto.randomUUID();this.pageViewId=crypto.randomUUID();}
}
export function createBrowserFlightdeck(options:BrowserOptions):BrowserFlightdeck {
  return new BrowserFlightdeck(options);
}

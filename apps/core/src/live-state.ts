import type {SinkRecord} from "./ingest";

export const LIVE_WINDOW_MS=30*60_000;
export const LIVE_MAX_EVENTS=256;
const maxStateBytes=96_000;
const id=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export type LiveEvent={sourceId:string;eventId:string;sessionId:string;actorId:string;
 environment:string;eventName:string;occurredAt:string;receivedAt:string};
export type LiveState={projectId:string;events:LiveEvent[]};
export type LiveSession={sourceId:string;sessionId:string;actorId:string;environment:string;
 firstSeen:string;lastSeen:string;lastEvent:string;events:number};
export function checkProject(projectId:string){
 if(!id.test(projectId))throw new Error("invalid_live_project");
}
/** Only accepted, recently occurring metadata enters this optional projection. */
export function updateLiveState(state:LiveState|undefined,projectId:string,records:readonly SinkRecord[],now:number):LiveState{
 checkProject(projectId);
 if(state&&state.projectId!==projectId)throw new Error("live_project_mismatch");
 const events=(state?.events??[]).filter(e=>Date.parse(e.receivedAt)>now-LIVE_WINDOW_MS);
 const seen=new Set(events.map(e=>JSON.stringify([e.sourceId,e.eventId])));
 for(const r of records){
  if(r.project_id!==projectId)throw new Error("live_project_mismatch");
  if(!id.test(r.session_id)||!id.test(r.source_id)||!id.test(r.event_id)||
   !/^[a-z][a-z0-9_.-]{0,127}$/.test(r.event_name)||r.environment.length>128)continue;
  const occurred=Date.parse(r.occurred_at),received=Date.parse(r.received_at);
  if(!Number.isFinite(occurred)||!Number.isFinite(received)||occurred<=now-LIVE_WINDOW_MS||
   occurred>now+5*60_000||received<=now-LIVE_WINDOW_MS||received>now+5*60_000)continue;
  const key=JSON.stringify([r.source_id,r.event_id]);
  if(seen.has(key))continue;
  seen.add(key);
  events.push({sourceId:r.source_id,eventId:r.event_id,sessionId:r.session_id,
   actorId:id.test(r.actor_id)?r.actor_id:"",environment:r.environment,eventName:r.event_name,
   occurredAt:r.occurred_at,receivedAt:r.received_at});
 }
 events.sort((a,b)=>a.receivedAt.localeCompare(b.receivedAt));
 const next={projectId,events:events.slice(-LIVE_MAX_EVENTS)};
 while(new TextEncoder().encode(JSON.stringify(next)).length>maxStateBytes)next.events.shift();
 return next;
}
export function liveSnapshot(state:LiveState,now:number){
 const sessions=new Map<string,LiveSession>();
 for(const e of state.events){
  if(Date.parse(e.receivedAt)<=now-LIVE_WINDOW_MS)continue;
  const key=JSON.stringify([e.sourceId,e.environment,e.sessionId]);
  const s=sessions.get(key);
  if(!s)sessions.set(key,{sourceId:e.sourceId,sessionId:e.sessionId,environment:e.environment,
   actorId:e.actorId,firstSeen:e.occurredAt,lastSeen:e.occurredAt,lastEvent:e.eventName,events:1});
  else{
   s.events++;
   if(e.occurredAt<s.firstSeen)s.firstSeen=e.occurredAt;
   if(e.occurredAt>=s.lastSeen){s.lastSeen=e.occurredAt;s.lastEvent=e.eventName;s.actorId=e.actorId||s.actorId;}
  }
 }
 return {sessions:[...sessions.values()].sort((a,b)=>b.lastSeen.localeCompare(a.lastSeen)).slice(0,100),
  updatedAt:new Date(now).toISOString(),windowSeconds:LIVE_WINDOW_MS/1000,
  maxEvents:LIVE_MAX_EVENTS,retainedEvents:state.events.filter(e=>Date.parse(e.receivedAt)>now-LIVE_WINDOW_MS).length};
}

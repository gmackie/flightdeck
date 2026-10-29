import {DurableObject} from "cloudflare:workers";
import type {SinkRecord} from "./ingest";
import {checkProject,updateLiveState,liveSnapshot,LIVE_WINDOW_MS,type LiveState} from "./live-state";

/** Private, project-keyed bounded cache. Canonical history stays in Basin. */
export class LiveSessions extends DurableObject {
 async publish(projectId:string,records:SinkRecord[]){
  const now=Date.now();
  await this.ctx.storage.transaction(async storage=>{
   const state=await storage.get<LiveState>("state");
   await storage.put("state",updateLiveState(state,projectId,records,now));
   await storage.setAlarm(now+LIVE_WINDOW_MS);
  });
 }
 async snapshot(projectId:string){
  checkProject(projectId);
  const state=await this.ctx.storage.get<LiveState>("state");
  if(state&&state.projectId!==projectId)throw new Error("live_project_mismatch");
  return liveSnapshot(state??{projectId,events:[]},Date.now());
 }
 async alarm(){
  await this.ctx.storage.transaction(async storage=>{
   const state=await storage.get<LiveState>("state");
   if(!state)return;
   const next=updateLiveState(state,state.projectId,[],Date.now());
   if(next.events.length){await storage.put("state",next);await storage.setAlarm(Date.now()+LIVE_WINDOW_MS);}
   else await storage.delete("state");
  });
 }
}

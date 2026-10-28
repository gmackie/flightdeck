import {DurableObject} from "cloudflare:workers";
import {transition,validateJourney,type JourneyDefinition} from "@flightdeck/journey-model";

/** Must match the stable flat Basin event record. */
type InputEvent={
 event_id:string;event_name:string;project_id:string;occurred_at:string;received_at:string;objects_json:string;
};
type DBJourney={id:string;project_id:string;object_type:string;version:number;initial_state:string;transitions_json:string};
interface Env {JOURNEYS:DurableObjectNamespace<JourneyInstance>;META:D1Database;}
const recordId=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function decodeObjects(record:InputEvent):Array<{type:string;id:string}> {
 try{
  const result:unknown=JSON.parse(record.objects_json);
  if(!Array.isArray(result))return [];
  return result.filter(o=>o&&typeof o==="object"&&recordId.test(o.type)&&recordId.test(o.id)).slice(0,8);
 }catch{return [];}
}
function fromRow(r:DBJourney):JourneyDefinition {
 return validateJourney({id:r.id,projectId:r.project_id,objectType:r.object_type,
  version:r.version,initialState:r.initial_state,transitions:JSON.parse(r.transitions_json)});
}
export class JourneyInstance extends DurableObject<Env> {
 constructor(ctx:DurableObjectState,env:Env){
  super(ctx,env);
  this.ctx.storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS processed(event_id TEXT PRIMARY KEY,received_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS journey_state(
      journey_id TEXT PRIMARY KEY, version INTEGER NOT NULL, state TEXT NOT NULL,
      last_occurrence TEXT NOT NULL,updated_at TEXT NOT NULL);
  `);
 }
 async record(record:InputEvent,definitions:JourneyDefinition[]):Promise<{duplicate:boolean;updates:number}> {
  if(!recordId.test(record.event_id)||!recordId.test(record.project_id)||!record.event_name)
   throw new Error("invalid_journey_event");
  const defs=definitions.map(validateJourney).filter(d=>d.projectId===record.project_id);
  const result=this.ctx.storage.transactionSync(()=>{
    const seen=[...this.ctx.storage.sql.exec<{event_id:string}>("SELECT event_id FROM processed WHERE event_id = ?",record.event_id)];
    if(seen.length)return {duplicate:true,updates:0};
    let updates=0;
    for(const d of defs){
      const rows=[...this.ctx.storage.sql.exec<{version:number;state:string;last_occurrence:string}>(
        "SELECT version,state,last_occurrence FROM journey_state WHERE journey_id = ?",d.id)];
      const prior=rows[0];
      const priorState=prior&&prior.version===d.version?prior.state:d.initialState;
      const lastTime=prior&&prior.version===d.version?prior.last_occurrence:"";
      if(lastTime&&record.occurred_at<lastTime)continue; // Late events are reconciled from canonical history.
      const next=transition(d,priorState,record.event_name);
      if(next!==priorState){
        this.ctx.storage.sql.exec(
          "INSERT INTO journey_state (journey_id,version,state,last_occurrence,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(journey_id) DO UPDATE SET version=excluded.version,state=excluded.state,last_occurrence=excluded.last_occurrence,updated_at=excluded.updated_at",
          d.id,d.version,next,record.occurred_at,new Date().toISOString());
        updates++;
      }
    }
    this.ctx.storage.sql.exec("INSERT INTO processed(event_id,received_at) VALUES (?,?)",record.event_id,record.received_at);
    return {duplicate:false,updates};
  });
  if(await this.ctx.storage.getAlarm()===null)await this.ctx.storage.setAlarm(Date.now()+86_400_000);
  return result;
 }
 async getStates():Promise<Array<{journey_id:string;version:number;state:string;updated_at:string}>>{
  return [...this.ctx.storage.sql.exec<{journey_id:string;version:number;state:string;updated_at:string}>(
    "SELECT journey_id,version,state,updated_at FROM journey_state")];
 }
 override async alarm():Promise<void>{
  this.ctx.storage.sql.exec("DELETE FROM processed WHERE received_at < ?",new Date(Date.now()-30*86_400_000).toISOString());
  await this.ctx.storage.setAlarm(Date.now()+86_400_000);
 }
}
export default {
 async queue(batch:MessageBatch<InputEvent>,env:Env):Promise<void>{
  for(const msg of batch.messages){
   const e=msg.body;
   if(!e||!recordId.test(e.project_id)||!recordId.test(e.event_id)){msg.ack();continue;}
   const objects=decodeObjects(e);
   if(!objects.length){msg.ack();continue;}
   try{
    for(const obj of objects){
      const result=await env.META.prepare(
        "SELECT id,project_id,object_type,version,initial_state,transitions_json FROM journey_definitions WHERE project_id = ? AND object_type = ? AND enabled = 1 LIMIT 50"
      ).bind(e.project_id,obj.type).all<DBJourney>();
      if(!result.results.length)continue;
      const id=env.JOURNEYS.idFromName(e.project_id+":"+obj.type+":"+obj.id);
      await env.JOURNEYS.get(id).record(e,result.results.map(fromRow));
    }
    msg.ack();
   }catch(err){console.error("Journey processing failed",err);msg.retry();}
  }
 },
} satisfies ExportedHandler<Env,InputEvent>;

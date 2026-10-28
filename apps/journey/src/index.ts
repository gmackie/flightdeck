import {DurableObject} from "cloudflare:workers";
import {
  replayJourney,validateJourney,type JourneyDefinition,type JourneyObservation,type JourneySnapshot
} from "@flightdeck/journey-model";

/** Must match the flat, server-authored canonical event record. */
export type InputEvent={
  source_id:string;event_id:string;event_name:string;project_id:string;
  actor_id?:string;occurred_at:string;received_at:string;objects_json:string;
};
export type ObjectScope={projectId:string;objectType:string;objectId:string};
type DBJourney={
  id:string;project_id:string;object_type:string;version:number;
  initial_state:string;transitions_json:string;
  terminal_states_json:string;max_duration_days:number;
};
type HistoryRow={source_id:string;event_id:string;event_name:string;occurred_at:string};
type StateRow={
  journey_id:string;version:number;state:string;last_occurrence:string;
  updated_at:string;applied_json:string;observed_events:number;
};
interface Env {
  JOURNEYS:DurableObjectNamespace<JourneyInstance>;
  META:D1Database;
  /** Secret for the private Worker service-binding HTTP interface. */
  JOURNEY_INTERNAL_TOKEN?:string;
}
const id=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const event=/^[a-z][a-z0-9_.-]{0,127}$/;
const maxHistory=4096;
const json=(value:unknown,status=200)=>Response.json(value,{
  status,headers:{"Cache-Control":"no-store"}
});
function validScope(scope:ObjectScope):boolean{
  return !!scope&&id.test(scope.projectId)&&id.test(scope.objectType)&&id.test(scope.objectId);
}
function decodeObjects(record:InputEvent):Array<{type:string;id:string}>{
  const unique=new Map<string,{type:string;id:string}>();
  try{
    const result:unknown=JSON.parse(record.objects_json);
    if(Array.isArray(result))for(const o of result){
      if(o&&typeof o==="object"&&typeof o.type==="string"&&typeof o.id==="string"&&
        id.test(o.type)&&id.test(o.id))unique.set(o.type+":"+o.id,{type:o.type,id:o.id});
    }
  }catch{/* malformed business-object reference: ignore */}
  if(record.actor_id&&id.test(record.actor_id))
    unique.set("actor:"+record.actor_id,{type:"actor",id:record.actor_id});
  return [...unique.values()].slice(0,8);
}
function fromRow(r:DBJourney):JourneyDefinition{
  return validateJourney({id:r.id,projectId:r.project_id,objectType:r.object_type,
    version:r.version,initialState:r.initial_state,transitions:JSON.parse(r.transitions_json),
    terminalStates:JSON.parse(r.terminal_states_json),maxDurationDays:r.max_duration_days});
}
async function definitionsFor(env:Env,scope:ObjectScope):Promise<JourneyDefinition[]> {
  const result=await env.META.prepare(
    "SELECT id,project_id,object_type,version,initial_state,transitions_json,terminal_states_json,max_duration_days FROM journey_definitions WHERE project_id=? AND object_type=? AND enabled=1 LIMIT 50"
  ).bind(scope.projectId,scope.objectType).all<DBJourney>();
  return result.results.map(fromRow);
}
function verifyEvent(record:InputEvent,scope:ObjectScope):void{
  if(!record||record.project_id!==scope.projectId||!id.test(record.source_id)||!id.test(record.event_id)||
    !event.test(record.event_name)||!Number.isFinite(Date.parse(record.occurred_at))||
    !Number.isFinite(Date.parse(record.received_at)))throw new Error("invalid_journey_event");
  if(!decodeObjects(record).some(obj=>obj.type===scope.objectType&&obj.id===scope.objectId))
    throw new Error("event_object_scope_mismatch");
}
/** One DO per project/object identity. Can be rehydrated from canonical history. */
export class JourneyInstance extends DurableObject<Env>{
  constructor(ctx:DurableObjectState,env:Env){
    super(ctx,env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS scope(project_id TEXT NOT NULL,object_type TEXT NOT NULL,object_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS event_history(
        source_id TEXT NOT NULL,event_id TEXT NOT NULL,event_name TEXT NOT NULL,
        occurred_at TEXT NOT NULL,received_at TEXT NOT NULL,
        PRIMARY KEY(source_id,event_id)
      );
      CREATE INDEX IF NOT EXISTS idx_journey_time ON event_history(occurred_at);
      CREATE TABLE IF NOT EXISTS journey_state(
        journey_id TEXT PRIMARY KEY,version INTEGER NOT NULL,state TEXT NOT NULL,
        last_occurrence TEXT NOT NULL,updated_at TEXT NOT NULL,
        applied_json TEXT NOT NULL,observed_events INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS replay_metadata(
        key TEXT PRIMARY KEY,value TEXT NOT NULL
      );
    `);
  }
  private assertScope(scope:ObjectScope){
    if(!validScope(scope))throw new Error("invalid_object_scope");
    const stored=[...this.ctx.storage.sql.exec<ObjectScope>(
      "SELECT project_id AS projectId,object_type AS objectType,object_id AS objectId FROM scope LIMIT 1"
    )][0];
    if(stored){
      if(stored.projectId!==scope.projectId||stored.objectType!==scope.objectType||stored.objectId!==scope.objectId)
        throw new Error("object_scope_mismatch");
    }else{
      this.ctx.storage.sql.exec("INSERT INTO scope(project_id,object_type,object_id) VALUES(?,?,?)",
        scope.projectId,scope.objectType,scope.objectId);
    }
  }
  private loadHistory():JourneyObservation[]{
    const rows=[...this.ctx.storage.sql.exec<HistoryRow>(
      "SELECT source_id,event_id,event_name,occurred_at FROM event_history ORDER BY occurred_at,source_id,event_id LIMIT 4097"
    )];
    if(rows.length>maxHistory)throw new Error("journey_history_limit");
    return rows.map(r=>({eventId:r.event_id,sourceId:r.source_id,
      eventName:r.event_name,occurredAt:r.occurred_at}));
  }
  private recompute(definitions:readonly JourneyDefinition[],now:number):number{
    const history=this.loadHistory();
    let updates=0;
    for(const raw of definitions){
      const d=validateJourney(raw);
      const snapshot=replayJourney(d,history,now);
      const previous=[...this.ctx.storage.sql.exec<StateRow>(
        "SELECT * FROM journey_state WHERE journey_id=?",d.id
      )][0];
      if(!previous||previous.version!==d.version||previous.state!==snapshot.state||
        previous.last_occurrence!==(snapshot.lastOccurrence??"")){
        updates++;
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO journey_state
          (journey_id,version,state,last_occurrence,updated_at,applied_json,observed_events)
          VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(journey_id) DO UPDATE SET
            version=excluded.version,state=excluded.state,last_occurrence=excluded.last_occurrence,
            updated_at=excluded.updated_at,applied_json=excluded.applied_json,
            observed_events=excluded.observed_events`,
        d.id,d.version,snapshot.state,snapshot.lastOccurrence??"",
        new Date(now).toISOString(),JSON.stringify(snapshot.appliedTransitions),snapshot.observedEvents
      );
    }
    return updates;
  }
  async record(scope:ObjectScope,record:InputEvent,definitions:JourneyDefinition[])
    :Promise<{duplicate:boolean;updates:number}>{
    verifyEvent(record,scope);
    if(definitions.some(d=>d.projectId!==scope.projectId||d.objectType!==scope.objectType))
      throw new Error("definition_scope_mismatch");
    const now=Date.now();
    if(Date.parse(record.occurred_at)<now-30*86_400_000)
      throw new Error("event_outside_live_horizon");
    const result=this.ctx.storage.transactionSync(()=>{
      this.assertScope(scope);
      const insert=this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO event_history(source_id,event_id,event_name,occurred_at,received_at) VALUES(?,?,?,?,?)",
        record.source_id,record.event_id,record.event_name,record.occurred_at,record.received_at
      );
      const duplicate=insert.rowsWritten===0;
      const updates=this.recompute(definitions,now);
      return {duplicate,updates};
    });
    if(await this.ctx.storage.getAlarm()===null)await this.ctx.storage.setAlarm(now+86_400_000);
    return result;
  }
  /**
   * Replace the local journal with caller-provided canonical observations.
   * The caller must independently verify dataset completeness and watermark.
   */
  async reconcile(scope:ObjectScope,records:InputEvent[],definitions:JourneyDefinition[])
    :Promise<{observations:number;updated:number;origin:string}>{
    if(!validScope(scope)||!Array.isArray(records)||records.length>maxHistory)
      throw new Error("invalid_replay");
    for(const e of records)verifyEvent(e,scope);
    const now=Date.now();
    const updated=this.ctx.storage.transactionSync(()=>{
      this.assertScope(scope);
      this.ctx.storage.sql.exec("DELETE FROM event_history");
      for(const e of records)this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO event_history(source_id,event_id,event_name,occurred_at,received_at) VALUES(?,?,?,?,?)",
        e.source_id,e.event_id,e.event_name,e.occurred_at,e.received_at
      );
      const count=this.recompute(definitions,now);
      this.ctx.storage.sql.exec(
        "INSERT INTO replay_metadata(key,value) VALUES('last_reconciled_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        new Date(now).toISOString()
      );
      return count;
    });
    return {observations:records.length,updated,origin:"caller_supplied_history"};
  }
  async getStates(scope:ObjectScope):Promise<{states:Array<JourneySnapshot>;lastReconciledAt:string|null}>{
    this.assertScope(scope);
    const rows=[...this.ctx.storage.sql.exec<StateRow>("SELECT * FROM journey_state ORDER BY journey_id")];
    const meta=[...this.ctx.storage.sql.exec<{value:string}>(
      "SELECT value FROM replay_metadata WHERE key='last_reconciled_at' LIMIT 1"
    )][0];
    return {
      states:rows.map(r=>({
        journeyId:r.journey_id,version:r.version,state:r.state,
        lastOccurrence:r.last_occurrence||null,appliedTransitions:JSON.parse(r.applied_json),
        observedEvents:r.observed_events,
      })),
      lastReconciledAt:meta?.value??null,
    };
  }
  override async alarm():Promise<void>{
    this.ctx.storage.transactionSync(()=>{
      this.ctx.storage.sql.exec(
        "DELETE FROM event_history WHERE occurred_at < ?",
        new Date(Date.now()-30*86_400_000).toISOString()
      );
    });
    await this.ctx.storage.setAlarm(Date.now()+86_400_000);
  }
}
function tokenEqual(a:string,b:string):boolean{
  if(a.length<32||b.length<32||a.length!==b.length)return false;
  let diff=0;for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);
  return diff===0;
}
function parseScope(url:URL):ObjectScope{
  return {projectId:url.searchParams.get("projectId")??"",
    objectType:url.searchParams.get("type")??"",
    objectId:url.searchParams.get("objectId")??""};
}
export default {
  async fetch(request:Request,env:Env):Promise<Response>{
    // No public routes are configured, but verify the secret even across service bindings.
    const bearer=request.headers.get("Authorization")??"";
    if(!env.JOURNEY_INTERNAL_TOKEN || !bearer.startsWith("Bearer ") ||
      !tokenEqual(bearer.slice(7),env.JOURNEY_INTERNAL_TOKEN))return json({error:"not_found"},404);
    const url=new URL(request.url);
    if(url.pathname==="/internal/state"&&request.method==="GET"){
      const scope=parseScope(url);
      if(!validScope(scope))return json({error:"invalid_scope"},400);
      const object=env.JOURNEYS.get(env.JOURNEYS.idFromName(
        scope.projectId+":"+scope.objectType+":"+scope.objectId
      ));
      return json(await object.getStates(scope));
    }
    if(url.pathname==="/internal/reconcile"&&request.method==="POST"){
      const content=await request.text();
      if(content.length>1_000_000)return json({error:"too_large"},413);
      let input:unknown;try{input=JSON.parse(content);}catch{return json({error:"invalid_json"},400);}
      const x=input as {scope?:ObjectScope;records?:InputEvent[]};
      if(!x?.scope||!validScope(x.scope)||!Array.isArray(x.records)||x.records.length>maxHistory)
        return json({error:"invalid_replay"},400);
      const definitions=await definitionsFor(env,x.scope);
      const object=env.JOURNEYS.get(env.JOURNEYS.idFromName(
        x.scope.projectId+":"+x.scope.objectType+":"+x.scope.objectId
      ));
      return json(await object.reconcile(x.scope,x.records,definitions));
    }
    return json({error:"not_found"},404);
  },
  async queue(batch:MessageBatch<InputEvent>,env:Env):Promise<void>{
    for(const message of batch.messages){
      const e=message.body;
      if(!e||!id.test(e.project_id)||!id.test(e.source_id)||!id.test(e.event_id)){
        message.ack();continue;
      }
      if(Number.isFinite(Date.parse(e.occurred_at)) &&
         Date.parse(e.occurred_at)<Date.now()-30*86_400_000){
        message.ack();continue;
      }
      const targets=decodeObjects(e);
      if(!targets.length){message.ack();continue;}
      try{
        for(const target of targets){
          const scope={projectId:e.project_id,objectType:target.type,objectId:target.id};
          const definitions=await definitionsFor(env,scope);
          if(!definitions.length)continue;
          const object=env.JOURNEYS.get(env.JOURNEYS.idFromName(
            scope.projectId+":"+scope.objectType+":"+scope.objectId
          ));
          await object.record(scope,e,definitions);
        }
        message.ack();
      }catch(err){
        console.error("Journey processing failed",err);
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env,InputEvent>;

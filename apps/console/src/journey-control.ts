import { validateJourney, type JourneyDefinition } from "@flightdeck/journey-model";

export interface JourneyAdminEnv {
  META?: D1Database;
  PROJECT_ID: string;
  ADMIN_EMAILS?: string;
  JOURNEY_SERVICE?: Fetcher;
  JOURNEY_INTERNAL_KEY?: string;
}
export type JourneyPrincipal = {sub:string;email:string};
type Row={
  id:string;project_id:string;object_type:string;version:number;
  initial_state:string;transitions_json:string;terminal_states_json:string;
  max_duration_days:number;enabled:number;updated_at:string;
};
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{"Cache-Control":"no-store"}});
const idPattern=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const columns="id,project_id,object_type,version,initial_state,transitions_json,terminal_states_json,max_duration_days,enabled,updated_at";
const admin=(env:JourneyAdminEnv,p:JourneyPrincipal):boolean=>
  (env.ADMIN_EMAILS??"").toLowerCase().split(",").map(x=>x.trim()).filter(Boolean).includes(p.email.toLowerCase());
function mayMutate(req:Request,env:JourneyAdminEnv,p:JourneyPrincipal){
  return admin(env,p)&&req.headers.get("Origin")===new URL(req.url).origin;
}
async function parseJson(req:Request):Promise<unknown>{
  if(Number(req.headers.get("Content-Length")??"0")>12_000)throw new Error("too_large");
  const body=await req.text();
  if(body.length>12_000)throw new Error("too_large");
  try{return JSON.parse(body);}catch{throw new Error("invalid_json");}
}
function fromRow(r:Row){
  return {
    id:r.id,projectId:r.project_id,objectType:r.object_type,version:r.version,
    initialState:r.initial_state,transitions:JSON.parse(r.transitions_json),
    terminalStates:JSON.parse(r.terminal_states_json),maxDurationDays:r.max_duration_days,
    enabled:!!r.enabled,updatedAt:r.updated_at
  };
}
function definition(input:unknown,projectId:string,version:number):JourneyDefinition{
  if(!input||typeof input!=="object"||Array.isArray(input))throw new Error("invalid_definition");
  const d=input as JourneyDefinition;
  return validateJourney({id:d.id,projectId,objectType:d.objectType,version,
    initialState:d.initialState,transitions:d.transitions,
    terminalStates:d.terminalStates,maxDurationDays:d.maxDurationDays});
}
function audit(db:D1Database,projectId:string,principal:JourneyPrincipal,action:string,id:string,details:unknown){
  return db.prepare("INSERT INTO audit_log(id,project_id,principal,action,resource_id,details_json) VALUES(?,?,?,?,?,?)")
    .bind(crypto.randomUUID(),projectId,principal.sub,action,id,JSON.stringify(details));
}
export async function handleJourneyControl(
  request:Request,env:JourneyAdminEnv,principal:JourneyPrincipal
):Promise<Response|null>{
  const url=new URL(request.url),path=url.pathname,method=request.method;
  if(!path.startsWith("/api/journey-definitions")&&path!=="/api/journey-state")return null;
  if(!env.META)return json({error:"metadata_not_configured"},503);
  const db=env.META;
  try{
    if(path==="/api/journey-state"&&method==="GET"){
      if(!admin(env,principal))return json({error:"forbidden"},403);
      const objectType=url.searchParams.get("type")??"",objectId=url.searchParams.get("objectId")??"";
      if(!idPattern.test(objectType)||!idPattern.test(objectId))return json({error:"invalid_scope"},400);
      if(!env.JOURNEY_SERVICE||!env.JOURNEY_INTERNAL_KEY)return json({error:"journey_service_not_configured"},503);
      const destination=new URL("https://flightdeck-journey/internal/state");
      destination.searchParams.set("projectId",env.PROJECT_ID);
      destination.searchParams.set("type",objectType);
      destination.searchParams.set("objectId",objectId);
      const upstream=await env.JOURNEY_SERVICE.fetch(destination.toString(),{
        headers:{Authorization:"Bearer "+env.JOURNEY_INTERNAL_KEY}
      });
      if(!upstream.ok)return json({error:"journey_service_unavailable"},502);
      return json(await upstream.json());
    }
    if(path==="/api/journey-definitions"){
      if(method==="GET"){
        const result=await db.prepare("SELECT "+columns+" FROM journey_definitions WHERE project_id=? ORDER BY updated_at DESC LIMIT 100")
          .bind(env.PROJECT_ID).all<Row>();
        return json({items:result.results.map(fromRow)});
      }
      if(method!=="POST")return json({error:"method_not_allowed"},405);
      if(!mayMutate(request,env,principal))return json({error:"forbidden"},403);
      const d=definition(await parseJson(request),env.PROJECT_ID,1);
      await db.batch([
        db.prepare(
          "INSERT INTO journey_definitions(id,project_id,object_type,version,initial_state,transitions_json,terminal_states_json,max_duration_days,enabled) VALUES(?,?,?,?,?,?,?,?,0)"
        ).bind(d.id,env.PROJECT_ID,d.objectType,1,d.initialState,
          JSON.stringify(d.transitions),JSON.stringify(d.terminalStates??[]),d.maxDurationDays??30),
        audit(db,env.PROJECT_ID,principal,"journey.created",d.id,{version:1,enabled:false})
      ]);
      return json({...d,enabled:false},201);
    }
    const resourceId=path.match(/^\/api\/journey-definitions\/([A-Za-z0-9._:-]{1,128})$/)?.[1];
    if(!resourceId)return json({error:"not_found"},404);
    const row=await db.prepare("SELECT "+columns+" FROM journey_definitions WHERE id=? AND project_id=?")
      .bind(resourceId,env.PROJECT_ID).first<Row>();
    if(!row)return json({error:"not_found"},404);
    if(method==="GET")return json(fromRow(row));
    if(method!=="PUT"&&method!=="PATCH")return json({error:"method_not_allowed"},405);
    if(!mayMutate(request,env,principal))return json({error:"forbidden"},403);
    const parsed=await parseJson(request);
    const payload=parsed as {enabled?:unknown;expectedVersion?:unknown;approval?:unknown};
    if(!payload||payload.expectedVersion!==row.version)return json({error:"revision_conflict"},409);
    if(method==="PATCH"){
      if(typeof payload.enabled!=="boolean")return json({error:"invalid_enable_request"},400);
      if(payload.enabled&&(typeof payload.approval!=="string"||
        payload.approval.trim().length<12||payload.approval.length>512))
        return json({error:"explicit_approval_required"},400);
      const results=await db.batch([
        db.prepare("UPDATE journey_definitions SET enabled=?,updated_at=datetime('now') WHERE id=? AND project_id=? AND version=?")
          .bind(payload.enabled?1:0,resourceId,env.PROJECT_ID,row.version),
        audit(db,env.PROJECT_ID,principal,payload.enabled?"journey.enabled":"journey.disabled",resourceId,
          {version:row.version,approval:payload.enabled?payload.approval:undefined})
      ]);
      return json({updated:Number(results[0]?.meta?.changes??0)>0,enabled:payload.enabled});
    }
    const d=definition({...parsed as object,id:resourceId},env.PROJECT_ID,row.version+1);
    const results=await db.batch([
      db.prepare(
        "UPDATE journey_definitions SET object_type=?,version=?,initial_state=?,transitions_json=?,terminal_states_json=?,max_duration_days=?,enabled=0,updated_at=datetime('now') WHERE id=? AND project_id=? AND version=?"
      ).bind(d.objectType,d.version,d.initialState,JSON.stringify(d.transitions),JSON.stringify(d.terminalStates??[]),
        d.maxDurationDays??30,resourceId,env.PROJECT_ID,row.version),
      audit(db,env.PROJECT_ID,principal,"journey.edited",resourceId,{version:d.version,enabled:false}),
    ]);
    return json({updated:Number(results[0]?.meta?.changes??0)>0,enabled:false,definition:d});
  }catch(error){
    if((error as Error).message==="too_large")return json({error:"too_large"},413);
    if((error as Error).message==="invalid_json")return json({error:"invalid_json"},400);
    if((error as Error).name==="JourneyError"||(error as Error).message==="invalid_definition")
      return json({error:(error as Error).message},400);
    console.error("journey control failed",error);
    return json({error:"journey_control_unavailable"},503);
  }
}

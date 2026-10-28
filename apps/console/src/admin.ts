/**
 * Account-owned, Access-authenticated source administration.
 * Never returns stored hashes or token values except the one-time newly
 * generated secret at the moment a source is created or rotated.
 */
import type {Principal} from "./control";

export interface AdminEnv {
  META?:D1Database;PROJECT_ID:string;ADMIN_EMAILS?:string;
  ACCOUNT_ID?:string;BASIN_BUCKET?:string;BASIN_TABLE?:string;
  QUERY_QUOTA_REQUIRED?:string;AI_ENABLED?:string;GITHUB_REPOSITORY?:string;
}
type SourceRow={
  source_id:string;enabled:number;policy_json:string;
  previous_sha256:string|null;created_at:string;updated_at:string;
};
type SourcePolicy={
  allowedEvents:string[];allowedProperties:Record<string,string[]>;
  allowedEnvironments:string[];consentRequired:boolean;graphEnabled:boolean;
  allowedKinds:string[];
};
const idPattern=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const eventPattern=/^[a-z][a-z0-9_.-]{0,127}(?:\*)?$/;
const kindValues=new Set(["product","rum","error","exposure","agent"]);
const json=(body:unknown,status=200)=>Response.json(body,{
  status,headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}
});
export function adminAllowed(env:AdminEnv,principal:Principal):boolean{
  return (env.ADMIN_EMAILS??"").toLowerCase().split(",").map(x=>x.trim()).filter(Boolean)
    .includes(principal.email.toLowerCase());
}
const mutationAllowed=(req:Request,env:AdminEnv,principal:Principal)=>
  adminAllowed(env,principal)&&req.headers.get("Origin")===new URL(req.url).origin;
async function body(req:Request):Promise<unknown>{
  if(Number(req.headers.get("Content-Length")??"0")>16_384)throw new Error("body_too_large");
  const raw=await req.text();
  if(new TextEncoder().encode(raw).byteLength>16_384)throw new Error("body_too_large");
  try{return JSON.parse(raw);}catch{throw new Error("invalid_json");}
}
export function validateSourcePolicy(input:unknown):SourcePolicy{
  if(!input||typeof input!=="object"||Array.isArray(input))throw new Error("invalid_source_policy");
  const p=input as Record<string,unknown>;
  if(!Array.isArray(p.allowedEvents)||p.allowedEvents.length<1||p.allowedEvents.length>60||
    !p.allowedEvents.every(x=>typeof x==="string"&&eventPattern.test(x)))
    throw new Error("invalid_allowed_events");
  const props=p.allowedProperties??{};
  if(!props||typeof props!=="object"||Array.isArray(props)||Object.keys(props).length>60)
    throw new Error("invalid_allowed_properties");
  for(const [event,keys] of Object.entries(props)){
    if(!eventPattern.test(event)||!Array.isArray(keys)||keys.length>50||
      !keys.every(x=>typeof x==="string"&&/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(x)))
      throw new Error("invalid_allowed_properties");
  }
  const environments=p.allowedEnvironments??["production","staging"];
  if(!Array.isArray(environments)||environments.length>10||
    !environments.every(x=>typeof x==="string"&&idPattern.test(x)))
    throw new Error("invalid_environments");
  const kinds=p.allowedKinds??["product","rum","exposure"];
  if(!Array.isArray(kinds)||kinds.length>5||!kinds.every(x=>kindValues.has(x)))
    throw new Error("invalid_kinds");
  if(p.consentRequired!==undefined&&typeof p.consentRequired!=="boolean")
    throw new Error("invalid_consent_policy");
  if(p.graphEnabled!==undefined&&typeof p.graphEnabled!=="boolean")
    throw new Error("invalid_graph_policy");
  return {
    allowedEvents:[...p.allowedEvents] as string[],
    allowedProperties:props as Record<string,string[]>,
    allowedEnvironments:environments as string[],
    allowedKinds:kinds as string[],
    consentRequired:p.consentRequired===true,
    graphEnabled:p.graphEnabled===true
  };
}
export async function shaToken(token:string):Promise<string>{
  const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(token)));
  return [...digest].map(x=>x.toString(16).padStart(2,"0")).join("");
}
function token():string{
  const bytes=crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");
}
const defaults:SourcePolicy={
  allowedEvents:["page.viewed","rum.*"],
  allowedProperties:{"page.viewed":["route"],"rum.*":["value","rating","metricId"]},
  allowedEnvironments:["production","staging"],allowedKinds:["product","rum"],
  consentRequired:false,graphEnabled:false
};
async function audit(db:D1Database,project:string,principal:Principal,operation:string,source:string){
  await db.prepare(
    "INSERT INTO audit_log(id,project_id,principal,action,resource_id,details_json) VALUES(?,?,?,?,?,?)"
  ).bind(crypto.randomUUID(),project,principal.sub,operation,source,"{}").run();
}
export async function handleAdmin(req:Request,env:AdminEnv,principal:Principal):Promise<Response|null>{
  const u=new URL(req.url),path=u.pathname,method=req.method;
  if(!path.startsWith("/api/admin/"))return null;
  if(!adminAllowed(env,principal))return json({error:"forbidden"},403);
  if(!env.META)return json({error:"metadata_not_configured"},503);
  const db=env.META,project=env.PROJECT_ID;
  try{
    if(path==="/api/admin/status"&&method==="GET"){
      const schema=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('source_credentials','query_budgets','projects','audit_log')").all<{name:string}>();
      const names=new Set(schema.results.map(x=>x.name));
      const active=await db.prepare("SELECT COUNT(*) AS count FROM source_credentials WHERE project_id=? AND enabled=1")
        .bind(project).first<{count:number}>();
      const status=[
        {id:"access",ok:true,description:"Cloudflare Access assertion verified by console"},
        {id:"metadata",ok:names.has("projects")&&names.has("audit_log"),description:"D1 control schema"},
        {id:"sources",ok:names.has("source_credentials"),description:"Dynamic source-credential schema"},
        {id:"queries",ok:names.has("query_budgets"),description:"Query quota schema"},
        {id:"basin",ok:!!env.BASIN_BUCKET&&!!env.BASIN_TABLE,description:"Basin configured (connection not verified)"},
      ];
      return json({projectId:project,accountId:env.ACCOUNT_ID,
        checks:status,activeSources:active?.count??0,
        setupComplete:status.every(x=>x.ok),note:"Configuration checks only; no live ingestion/SQL probe"});
    }
    if(path==="/api/admin/sources"){
      if(method==="GET"){
        const result=await db.prepare(
          "SELECT source_id,enabled,policy_json,previous_sha256,created_at,updated_at FROM source_credentials WHERE project_id=? ORDER BY created_at DESC LIMIT 100"
        ).bind(project).all<SourceRow>();
        return json({items:result.results.map(x=>({
          id:x.source_id,enabled:x.enabled===1,rotationPending:!!x.previous_sha256,
          policy:JSON.parse(x.policy_json),
          createdAt:x.created_at,updatedAt:x.updated_at
        }))});
      }
      if(method==="POST"){
        if(!mutationAllowed(req,env,principal))return json({error:"origin_not_allowed"},403);
        const parsed=await body(req) as {id?:unknown;policy?:unknown;confirm?:unknown};
        if(parsed?.confirm!=="CREATE_SOURCE")return json({error:"confirmation_required"},400);
        if(typeof parsed.id!=="string"||!idPattern.test(parsed.id))return json({error:"invalid_source_id"},400);
        const policy=validateSourcePolicy(parsed.policy??defaults);
        const secret=token(),digest=await shaToken(secret);
        await db.prepare(
          "INSERT INTO source_credentials(project_id,source_id,token_sha256,policy_json,created_by) VALUES(?,?,?,?,?)"
        ).bind(project,parsed.id,digest,JSON.stringify(policy),principal.sub).run();
        await audit(db,project,principal,"source.created",parsed.id);
        return json({id:parsed.id,token:secret,policy,oneTimeSecret:true},201);
      }
      return json({error:"method_not_allowed"},405);
    }
    const match=path.match(/^\/api\/admin\/sources\/([A-Za-z0-9._:-]{1,128})\/(rotate|retire-old|disable|enable)$/);
    if(match){
      if(method!=="POST")return json({error:"method_not_allowed"},405);
      if(!mutationAllowed(req,env,principal))return json({error:"origin_not_allowed"},403);
      const sourceId=match[1]!,action=match[2]!;
      const parsed=await body(req) as {confirm?:unknown};
      if(parsed?.confirm!==(action==="retire-old"?"APPLY_RETIRE_OLD":"APPLY_"+action.toUpperCase()))
        return json({error:"confirmation_required"},400);
      if(action==="retire-old"){
        if(parsed?.confirm!=="APPLY_RETIRE_OLD")return json({error:"confirmation_required"},400);
        const result=await db.prepare(
          "UPDATE source_credentials SET previous_sha256=NULL,updated_at=datetime('now') WHERE project_id=? AND source_id=? AND previous_sha256 IS NOT NULL"
        ).bind(project,sourceId).run();
        if(Number(result.meta?.changes??0)!==1)return json({error:"no_rotation_pending"},409);
        await audit(db,project,principal,"source.old_key_retired",sourceId);
        return json({id:sourceId,previousTokenStillAccepted:false});
      }
      if(action==="rotate"){
        // Zero-downtime rotation: temporarily accept both hashes until old one is retired.
        const secret=token(),digest=await shaToken(secret);
        const result=await db.prepare(
          "UPDATE source_credentials SET previous_sha256=token_sha256,token_sha256=?,updated_at=datetime('now') WHERE project_id=? AND source_id=? AND enabled=1 AND previous_sha256 IS NULL"
        ).bind(digest,project,sourceId).run();
        if(Number(result.meta?.changes??0)!==1)return json({error:"source_not_found_or_rotation_pending"},409);
        await audit(db,project,principal,"source.rotated",sourceId);
        return json({id:sourceId,token:secret,oneTimeSecret:true,previousTokenStillAccepted:true});
      }
      const result=await db.prepare(
        "UPDATE source_credentials SET enabled=?,updated_at=datetime('now') WHERE project_id=? AND source_id=?"
      ).bind(action==="enable"?1:0,project,sourceId).run();
      if(Number(result.meta?.changes??0)!==1)return json({error:"source_not_found"},404);
      await audit(db,project,principal,"source."+action,sourceId);
      return json({id:sourceId,enabled:action==="enable"});
    }
    return json({error:"not_found"},404);
  }catch(error){
    const msg=(error as Error).message;
    if(msg==="body_too_large")return json({error:msg},413);
    if(["invalid_json","invalid_source_policy","invalid_allowed_events",
       "invalid_allowed_properties","invalid_environments","invalid_kinds",
       "invalid_consent_policy","invalid_graph_policy"].includes(msg))
      return json({error:msg},400);
    if(/UNIQUE constraint failed/i.test(msg))return json({error:"source_already_exists"},409);
    console.error("Flightdeck admin operation failed",error);
    return json({error:"admin_unavailable"},503);
  }
}

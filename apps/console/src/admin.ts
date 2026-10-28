import {
  AdminValidationError,defaultSourcePolicy,validateAdminOperation,
  validateSourceId,validateSourcePolicy,
  type AdminOperation,type SourcePolicy
} from "./admin-policy";

export type AdminPrincipal={sub:string;email:string};
export interface AdminEnv{
  META?:D1Database;
  PROJECT_ID:string;
  ADMIN_EMAILS?:string;
  QUERY_MONTHLY_UNITS?:string;
  AI_INVESTIGATION_DAILY_LIMIT?:string;
  ACCESS_TEAM_DOMAIN?:string;
  ACCESS_AUD?:string;
  CORE?:{status():Promise<unknown>};
  JOURNEY_SERVICE?:Fetcher;
}
type SourceRow={
  id:string;display_name:string;enabled:number;version:number;
  token_sha256:string|null;rotating_sha256_json:string;policy_json:string;
  created_at:string;updated_at:string|null;
};
type AdminSettings={
  project_id:string;query_units_monthly:number;ai_investigations_daily:number;
  version:number;updated_by:string;updated_at:string;
};
type ChangeRow={
  id:string;operation_json:string;rationale:string;proposed_by:string;
  status:string;proposed_at:string;reviewed_by:string|null;review_rationale:string|null;
};
const idPattern=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const uuidPattern=/^[0-9a-f-]{36}$/i;
const json=(x:unknown,status=200)=>Response.json(x,{
  status,headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}
});
const getAdminEmails=(env:AdminEnv)=>(env.ADMIN_EMAILS??"").toLowerCase()
  .split(",").map(x=>x.trim()).filter(Boolean);
export function isFlightdeckAdmin(env:AdminEnv,principal:AdminPrincipal):boolean{
  return !!principal?.email&&getAdminEmails(env).includes(principal.email.toLowerCase());
}
function mutable(request:Request):boolean{
  const url=new URL(request.url);
  return request.headers.get("Origin")===url.origin;
}
async function parseBody(request:Request):Promise<unknown>{
  const declared=Number(request.headers.get("Content-Length")??"0");
  if(!Number.isFinite(declared)||declared>16_384)throw new AdminValidationError("body_too_large");
  const raw=await request.text();
  if(new TextEncoder().encode(raw).byteLength>16_384)throw new AdminValidationError("body_too_large");
  try{return JSON.parse(raw);}catch{throw new AdminValidationError("invalid_json");}
}
function object(input:unknown):Record<string,unknown>{
  if(!input||typeof input!=="object"||Array.isArray(input))
    throw new AdminValidationError("invalid_payload");
  return input as Record<string,unknown>;
}
function expectedVersion(value:unknown):number{
  if(!Number.isSafeInteger(value)||Number(value)<1)
    throw new AdminValidationError("expected_version_required");
  return Number(value);
}
function rationale(value:unknown):string{
  if(typeof value!=="string"||value.trim().length<12||value.length>512)
    throw new AdminValidationError("approval_rationale_required");
  return value.trim();
}
function sha256(bytes:string):Promise<string>{
  return crypto.subtle.digest("SHA-256",new TextEncoder().encode(bytes))
    .then(buffer=>Array.from(new Uint8Array(buffer),b=>b.toString(16).padStart(2,"0")).join(""));
}
function newToken(){
  const random=crypto.getRandomValues(new Uint8Array(32));
  const str=Array.from(random,b=>String.fromCharCode(b)).join("");
  return btoa(str).replaceAll("+","-").replaceAll("/","_").replace(/=+$/,"");
}
async function audit(db:D1Database,env:AdminEnv,principal:AdminPrincipal,action:string,id:string,details:unknown={}){
  await db.prepare(
    "INSERT INTO audit_log(id,project_id,principal,action,resource_id,details_json) VALUES(?,?,?,?,?,?)"
  ).bind(crypto.randomUUID(),env.PROJECT_ID,principal.sub,action,id,JSON.stringify(details)).run();
}
async function readSource(db:D1Database,projectId:string,id:string):Promise<SourceRow|null>{
  return db.prepare(
    "SELECT id,display_name,enabled,version,token_sha256,rotating_sha256_json,policy_json,created_at,updated_at FROM sources WHERE id=? AND project_id=? LIMIT 1"
  ).bind(id,projectId).first<SourceRow>();
}
function publicSource(row:SourceRow){
  return {
    id:row.id,displayName:row.display_name,enabled:row.enabled===1,
    version:row.version,policy:JSON.parse(row.policy_json),
    rotationPending:JSON.parse(row.rotating_sha256_json).length>0,
    configured:!!row.token_sha256,
    createdAt:row.created_at,updatedAt:row.updated_at
  };
}
function limit(number:unknown,max:number):number{
  if(!Number.isSafeInteger(number)||Number(number)<0||Number(number)>max)
    throw new AdminValidationError("invalid_budget");
  return Number(number);
}
async function settings(db:D1Database,env:AdminEnv):Promise<AdminSettings>{
  const existing=await db.prepare(
    "SELECT project_id,query_units_monthly,ai_investigations_daily,version,updated_by,updated_at FROM admin_settings WHERE project_id=?"
  ).bind(env.PROJECT_ID).first<AdminSettings>();
  if(existing)return existing;
  const q=Number(env.QUERY_MONTHLY_UNITS??"50000");
  const a=Number(env.AI_INVESTIGATION_DAILY_LIMIT??"3");
  return {
    project_id:env.PROJECT_ID,
    query_units_monthly:Number.isSafeInteger(q)&&q>=0&&q<=100_000_000?q:0,
    ai_investigations_daily:Number.isSafeInteger(a)&&a>=0&&a<=100?a:0,
    version:0,updated_by:"environment",updated_at:""
  };
}
async function saveBudgets(
  db:D1Database,env:AdminEnv,principal:AdminPrincipal,
  options:{queryUnits:number;aiDailyLimit:number;version:number}
){
  const version=options.version;
  const current=await settings(db,env);
  if(current.version!==version)throw new AdminValidationError("revision_conflict");
  if(version===0){
    const result=await db.prepare(
      "INSERT OR IGNORE INTO admin_settings(project_id,query_units_monthly,ai_investigations_daily,version,updated_by) VALUES(?,?,?,?,?)"
    ).bind(env.PROJECT_ID,options.queryUnits,options.aiDailyLimit,1,principal.sub).run();
    if(Number(result.meta?.changes??0)!==1)
      throw new AdminValidationError("revision_conflict");
  }else{
    const result=await db.prepare(
      "UPDATE admin_settings SET query_units_monthly=?,ai_investigations_daily=?,updated_by=?,updated_at=datetime('now'),version=version+1 WHERE project_id=? AND version=?"
    ).bind(options.queryUnits,options.aiDailyLimit,principal.sub,env.PROJECT_ID,version).run();
    if(Number(result.meta?.changes??0)!==1)
      throw new AdminValidationError("revision_conflict");
  }
  const period=new Date().toISOString().slice(0,7),day=new Date().toISOString().slice(0,10);
  await db.batch([
    db.prepare("UPDATE query_budgets SET units_limit=? WHERE project_id=? AND period=?")
      .bind(options.queryUnits,env.PROJECT_ID,period),
    db.prepare("UPDATE ai_budgets SET investigations_limit=? WHERE project_id=? AND period=?")
      .bind(options.aiDailyLimit,env.PROJECT_ID,day)
  ]);
  await audit(db,env,principal,"admin.budgets.updated",env.PROJECT_ID,{
    queryUnits:options.queryUnits,aiDailyLimit:options.aiDailyLimit
  });
  return settings(db,env);
}
async function applyOperation(db:D1Database,env:AdminEnv,principal:AdminPrincipal,op:AdminOperation){
  switch(op.kind){
    case "source.disable":
    case "source.enable": {
      const changes=await db.prepare(
        "UPDATE sources SET enabled=?,version=version+1,updated_at=datetime('now') WHERE id=? AND project_id=?"
      ).bind(op.kind==="source.enable"?1:0,op.sourceId,env.PROJECT_ID).run();
      if(Number(changes.meta?.changes??0)!==1)throw new Error("source_missing");
      return;
    }
    case "source.policy":{
      const changes=await db.prepare(
        "UPDATE sources SET policy_json=?,version=version+1,updated_at=datetime('now') WHERE id=? AND project_id=?"
      ).bind(JSON.stringify(op.policy),op.sourceId,env.PROJECT_ID).run();
      if(Number(changes.meta?.changes??0)!==1)throw new Error("source_missing");
      return;
    }
    case "budget.query":
    case "budget.ai":{
      const previous=await settings(db,env);
      await saveBudgets(db,env,principal,{
        queryUnits:op.kind==="budget.query"?op.units:previous.query_units_monthly,
        aiDailyLimit:op.kind==="budget.ai"?op.dailyLimit:previous.ai_investigations_daily,
        version:previous.version,
      });
      return;
    }
  }
}
async function routeAdmin(request:Request,env:AdminEnv,principal:AdminPrincipal):Promise<Response>{
  const pathname=new URL(request.url).pathname,method=request.method;
  const db=env.META!;
  if(pathname==="/api/admin/overview"&&method==="GET"){
    const sources=await db.prepare(
      "SELECT COUNT(*) AS total, SUM(CASE WHEN enabled=1 THEN 1 ELSE 0 END) AS enabled FROM sources WHERE project_id=?"
    ).bind(env.PROJECT_ID).first<{total:number;enabled:number}>();
    const pending=await db.prepare(
      "SELECT COUNT(*) AS total FROM admin_change_requests WHERE project_id=? AND status='pending'"
    ).bind(env.PROJECT_ID).first<{total:number}>();
    const current=await settings(db,env);
    let coreStatus:unknown={configured:false};
    if(env.CORE){
      try{coreStatus=await env.CORE.status();}catch{coreStatus={error:"core_unavailable"};}
    }
    return json({
      projectId:env.PROJECT_ID,sourceCount:sources?.total??0,
      activeSources:sources?.enabled??0,pendingChanges:pending?.total??0,
      core:coreStatus,settings:current,adminEmail:principal.email,
      accessConfigured:!!env.ACCESS_AUD
    });
  }
  if(pathname==="/api/admin/sources"){
    if(method==="GET"){
      const rows=await db.prepare(
        "SELECT id,display_name,enabled,version,token_sha256,rotating_sha256_json,policy_json,created_at,updated_at FROM sources WHERE project_id=? ORDER BY id LIMIT 200"
      ).bind(env.PROJECT_ID).all<SourceRow>();
      return json({items:rows.results.map(publicSource)});
    }
    if(method==="POST"){
      if(!mutable(request))return json({error:"origin_not_allowed"},403);
      const input=object(await parseBody(request));
      const id=validateSourceId(input.id);
      const name=input.displayName??id;
      if(typeof name!=="string"||name.trim().length<1||name.length>120)
        throw new AdminValidationError("invalid_source_name");
      const policy=validateSourcePolicy(input.policy??defaultSourcePolicy());
      const token=newToken(),digest=await sha256(token);
      const result=await db.prepare(
        "INSERT OR IGNORE INTO sources(id,project_id,display_name,enabled,token_sha256,policy_json,rotating_sha256_json,version) VALUES(?,?,?,?,?,?,?,1)"
      ).bind(id,env.PROJECT_ID,name.trim(),1,digest,JSON.stringify(policy),"[]").run();
      if(Number(result.meta?.changes??0)!==1)return json({error:"source_exists"},409);
      await audit(db,env,principal,"source.created",id,{allowedEvents:policy.allowedEvents});
      return json({id,projectId:env.PROJECT_ID,token,tokenVisibleOnce:true,policy},201);
    }
    return json({error:"method_not_allowed"},405);
  }
  const sourcePath=pathname.match(/^\/api\/admin\/sources\/([A-Za-z0-9._:-]{1,128})(?:\/(rotate|promote|cancel-rotation))?$/);
  if(sourcePath){
    const id=validateSourceId(sourcePath[1]),action=sourcePath[2];
    const row=await readSource(db,env.PROJECT_ID,id);
    if(!row)return json({error:"source_not_found"},404);
    if(method==="GET"&&!action)return json(publicSource(row));
    if(!mutable(request))return json({error:"origin_not_allowed"},403);
    if(action==="rotate"&&method==="POST"){
      const input=object(await parseBody(request));
      if(expectedVersion(input.expectedVersion)!==row.version)return json({error:"revision_conflict"},409);
      if(JSON.parse(row.rotating_sha256_json).length>0)return json({error:"rotation_already_pending"},409);
      const token=newToken(),digest=await sha256(token);
      const result=await db.prepare(
        "UPDATE sources SET rotating_sha256_json=?,version=version+1,updated_at=datetime('now') WHERE id=? AND project_id=? AND version=?"
      ).bind(JSON.stringify([digest]),id,env.PROJECT_ID,row.version).run();
      if(Number(result.meta?.changes??0)!==1)return json({error:"revision_conflict"},409);
      await audit(db,env,principal,"source.rotation_started",id,{version:row.version+1});
      return json({id,token,tokenVisibleOnce:true,version:row.version+1},201);
    }
    if(action==="promote"&&method==="POST"){
      const input=object(await parseBody(request));
      if(expectedVersion(input.expectedVersion)!==row.version)return json({error:"revision_conflict"},409);
      if(typeof input.token!=="string"||input.token.length<32||input.token.length>256)
        throw new AdminValidationError("rotation_token_required");
      const digest=await sha256(input.token);
      const hashes=JSON.parse(row.rotating_sha256_json) as unknown;
      if(!Array.isArray(hashes)||!hashes.includes(digest))
        return json({error:"rotation_token_mismatch"},409);
      const result=await db.prepare(
        "UPDATE sources SET token_sha256=?,rotating_sha256_json='[]',version=version+1,updated_at=datetime('now') WHERE id=? AND project_id=? AND version=?"
      ).bind(digest,id,env.PROJECT_ID,row.version).run();
      if(Number(result.meta?.changes??0)!==1)return json({error:"revision_conflict"},409);
      await audit(db,env,principal,"source.rotation_promoted",id,{version:row.version+1});
      return json({id,rotationCompleted:true,version:row.version+1});
    }
    if(action==="cancel-rotation"&&method==="POST"){
      const input=object(await parseBody(request));
      if(expectedVersion(input.expectedVersion)!==row.version)return json({error:"revision_conflict"},409);
      const result=await db.prepare(
        "UPDATE sources SET rotating_sha256_json='[]',version=version+1,updated_at=datetime('now') WHERE id=? AND project_id=? AND version=?"
      ).bind(id,env.PROJECT_ID,row.version).run();
      if(Number(result.meta?.changes??0)!==1)return json({error:"revision_conflict"},409);
      await audit(db,env,principal,"source.rotation_cancelled",id);
      return json({id,cancelled:true,version:row.version+1});
    }
    if(!action&&method==="PATCH"){
      const input=object(await parseBody(request));
      if(expectedVersion(input.expectedVersion)!==row.version)return json({error:"revision_conflict"},409);
      if(input.enabled===undefined&&input.policy===undefined)
        throw new AdminValidationError("nothing_to_update");
      const enabled=input.enabled===undefined?row.enabled===1:input.enabled;
      if(typeof enabled!=="boolean")throw new AdminValidationError("invalid_enabled");
      const policy=input.policy===undefined?JSON.parse(row.policy_json):validateSourcePolicy(input.policy);
      const result=await db.prepare(
        "UPDATE sources SET enabled=?,policy_json=?,version=version+1,updated_at=datetime('now') WHERE id=? AND project_id=? AND version=?"
      ).bind(enabled?1:0,JSON.stringify(policy),id,env.PROJECT_ID,row.version).run();
      if(Number(result.meta?.changes??0)!==1)return json({error:"revision_conflict"},409);
      await audit(db,env,principal,"source.updated",id,{enabled,policyUpdated:input.policy!==undefined});
      return json({id,enabled,policy,version:row.version+1});
    }
    return json({error:"method_not_allowed"},405);
  }
  if(pathname==="/api/admin/budgets"){
    if(method==="GET"){
      const current=await settings(db,env);
      const month=new Date().toISOString().slice(0,7);
      const day=new Date().toISOString().slice(0,10);
      const [query,ai]=await Promise.all([
        db.prepare("SELECT units_used,units_limit FROM query_budgets WHERE project_id=? AND period=?")
          .bind(env.PROJECT_ID,month).first<{units_used:number;units_limit:number}>(),
        db.prepare("SELECT investigations_used,investigations_limit FROM ai_budgets WHERE project_id=? AND period=?")
          .bind(env.PROJECT_ID,day).first<{investigations_used:number;investigations_limit:number}>()
      ]);
      return json({settings:current,queryUsage:query??{units_used:0,units_limit:current.query_units_monthly},
        aiUsage:ai??{investigations_used:0,investigations_limit:current.ai_investigations_daily}});
    }
    if(method==="PUT"){
      if(!mutable(request))return json({error:"origin_not_allowed"},403);
      const input=object(await parseBody(request));
      const data=await saveBudgets(db,env,principal,{
        queryUnits:limit(input.queryUnits,100_000_000),
        aiDailyLimit:limit(input.aiDailyLimit,100),
        version:input.expectedVersion===0?0:expectedVersion(input.expectedVersion),
      });
      return json({settings:data});
    }
    return json({error:"method_not_allowed"},405);
  }
  if(pathname==="/api/admin/audit"&&method==="GET"){
    const rows=await db.prepare(
      "SELECT id,principal,action,resource_id,details_json,created_at FROM audit_log WHERE project_id=? ORDER BY created_at DESC LIMIT 100"
    ).bind(env.PROJECT_ID).all();
    return json({items:rows.results});
  }
  if(pathname==="/api/admin/requests"){
    if(method==="GET"){
      const result=await db.prepare(
        "SELECT id,operation_json,rationale,proposed_by,status,proposed_at,reviewed_by,review_rationale FROM admin_change_requests WHERE project_id=? ORDER BY proposed_at DESC LIMIT 100"
      ).bind(env.PROJECT_ID).all<ChangeRow>();
      return json({items:result.results.map(row=>({...row,operation:JSON.parse(row.operation_json),
        operation_json:undefined}))});
    }
    if(method==="POST"){
      if(!mutable(request))return json({error:"origin_not_allowed"},403);
      const input=object(await parseBody(request));
      const op=validateAdminOperation(input.operation);
      const why=rationale(input.rationale);
      const id=crypto.randomUUID();
      await db.prepare(
        "INSERT INTO admin_change_requests(id,project_id,operation_json,rationale,proposed_by,status) VALUES(?,?,?,?,?,'pending')"
      ).bind(id,env.PROJECT_ID,JSON.stringify(op),why,principal.sub).run();
      await audit(db,env,principal,"admin.change_proposed",id,{kind:op.kind});
      return json({id,status:"pending",operation:op},201);
    }
    return json({error:"method_not_allowed"},405);
  }
  const decisionPath=pathname.match(/^\/api\/admin\/requests\/([0-9a-f-]{36})\/decision$/i);
  if(decisionPath&&method==="POST"){
    if(!mutable(request))return json({error:"origin_not_allowed"},403);
    const input=object(await parseBody(request));
    const decision=input.decision;
    if(decision!=="approve"&&decision!=="reject")throw new AdminValidationError("invalid_decision");
    if(input.confirm!=="APPLY_CHANGE")throw new AdminValidationError("explicit_confirmation_required");
    const why=rationale(input.rationale);
    const requestId=decisionPath[1];
    const row=await db.prepare(
      "SELECT operation_json,status FROM admin_change_requests WHERE id=? AND project_id=?"
    ).bind(requestId,env.PROJECT_ID).first<{operation_json:string;status:string}>();
    if(!row)return json({error:"request_not_found"},404);
    if(row.status!=="pending")return json({error:"already_decided",status:row.status},409);
    const next=decision==="approve"?"applying":"rejected";
    const claimed=await db.prepare(
      "UPDATE admin_change_requests SET status=?,reviewed_by=?,review_rationale=?,reviewed_at=datetime('now') WHERE id=? AND project_id=? AND status='pending'"
    ).bind(next,principal.sub,why,requestId,env.PROJECT_ID).run();
    if(Number(claimed.meta?.changes??0)!==1)return json({error:"already_decided"},409);
    if(decision==="reject"){
      await audit(db,env,principal,"admin.change_rejected",requestId,{rationale:why});
      return json({status:"rejected"});
    }
    const op=validateAdminOperation(JSON.parse(row.operation_json));
    try{
      await applyOperation(db,env,principal,op);
      await db.prepare(
        "UPDATE admin_change_requests SET status='applied' WHERE id=? AND project_id=? AND status='applying'"
      ).bind(requestId,env.PROJECT_ID).run();
      await audit(db,env,principal,"admin.change_applied",requestId,{kind:op.kind});
      return json({status:"applied",operation:op});
    }catch(error){
      console.error("Admin change execution failed",error);
      // Do not retry automatically: mutation could have committed before failure.
      await db.prepare(
        "UPDATE admin_change_requests SET status='failed' WHERE id=? AND project_id=? AND status='applying'"
      ).bind(requestId,env.PROJECT_ID).run();
      return json({error:"admin_change_requires_reconciliation",status:"failed"},503);
    }
  }
  return json({error:"not_found"},404);
}
export async function handleAdmin(
  request:Request,env:AdminEnv,principal:AdminPrincipal
):Promise<Response|null>{
  const url=new URL(request.url);
  if(!url.pathname.startsWith("/api/admin/"))return null;
  if(!isFlightdeckAdmin(env,principal))return json({error:"forbidden"},403);
  if(!env.META)return json({error:"metadata_not_configured"},503);
  try{return await routeAdmin(request,env,principal);}
  catch(error){
    if(error instanceof AdminValidationError)
      return json({error:error.code},error.code==="body_too_large"?413:error.code==="revision_conflict"?409:400);
    console.error("Flightdeck administrator operation unavailable",error);
    return json({error:"admin_operation_unavailable"},503);
  }
}

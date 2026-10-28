import { validateQuery, type QueryKind, type QuerySpec } from "@flightdeck/query";
import { executeBasinQuery, type QueryRuntimeEnv } from "./query-runtime";

export type Principal = { sub: string; email: string };
export interface ControlEnv extends QueryRuntimeEnv {
  META?: D1Database;
  ADMIN_EMAILS?: string;
}
type SavedQuery = {
  kind: QueryKind;
  days: number;
  eventName?: string;
  limit?: number;
  steps?: string[];
};
type InsightRow = {
  id:string;name:string;query_json:string;created_by:string;updated_at:string;
};
const json=(value:unknown,status=200)=>Response.json(value,{
  status,headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}
});
const idRegex=/^[A-Za-z0-9_-]{1,128}$/;
function isAdmin(env:ControlEnv,principal:Principal):boolean {
  const emails=(env.ADMIN_EMAILS??"").toLowerCase().split(",").map(x=>x.trim()).filter(Boolean);
  return emails.includes(principal.email.toLowerCase());
}
function isMutationAllowed(request:Request,principal:Principal,env:ControlEnv):boolean {
  const url=new URL(request.url);
  return isAdmin(env,principal)&&request.headers.get("Origin")===url.origin;
}
async function readBody(request:Request):Promise<unknown>{
  const length=Number(request.headers.get("Content-Length")??0);
  if(length>12_288)throw new Error("body_too_large");
  const raw=await request.text();
  if(new TextEncoder().encode(raw).byteLength>12_288)throw new Error("body_too_large");
  try{return JSON.parse(raw);}catch{throw new Error("invalid_json");}
}
function validateSavedQuery(input:unknown,env:ControlEnv,now=Date.now()):SavedQuery{
  if(!input||typeof input!=="object"||Array.isArray(input))
    throw new Error("invalid_saved_query");
  const spec=input as SavedQuery;
  if(!Number.isInteger(spec.days)||spec.days<1||spec.days>90)
    throw new Error("invalid_window");
  const to=new Date(now).toISOString();
  const from=new Date(now-spec.days*86_400_000).toISOString();
  validateQuery({...spec,from,to},{projectId:env.PROJECT_ID,table:env.BASIN_TABLE},now);
  return {
    kind:spec.kind,days:spec.days,
    ...(spec.eventName?{eventName:spec.eventName}:{}),
    ...(spec.limit?{limit:spec.limit}:{}),
    ...(spec.steps?{steps:[...spec.steps]}:{}),
  };
}
function hydrateSavedQuery(value:SavedQuery,now=Date.now()):QuerySpec{
  return {...value,from:new Date(now-value.days*86_400_000).toISOString(),to:new Date(now).toISOString()};
}
function validName(s:unknown,max=120):s is string{
  return typeof s==="string"&&s.trim().length>=1&&s.trim().length<=max;
}
async function logMutation(db:D1Database,project:string,principal:Principal,action:string,id:string){
  return db.prepare("INSERT INTO audit_log(id,project_id,principal,action,resource_id,details_json) VALUES(?,?,?,?,?,?)")
    .bind(crypto.randomUUID(),project,principal.sub,action,id,"{}");
}
async function createInsight(req:Request,env:ControlEnv,principal:Principal):Promise<Response>{
  const body=await readBody(req);
  if(!body||typeof body!=="object")return json({error:"invalid_payload"},400);
  const b=body as {name?:unknown;query?:unknown};
  if(!validName(b.name))return json({error:"invalid_name"},400);
  let spec:SavedQuery;
  try{spec=validateSavedQuery(b.query,env);}catch(e){return json({error:String((e as Error).message)},400);}
  const id=crypto.randomUUID();
  const db=env.META!;
  await db.batch([
    db.prepare("INSERT INTO saved_insights(id,project_id,name,query_json,created_by) VALUES(?,?,?,?,?)")
      .bind(id,env.PROJECT_ID,b.name.trim(),JSON.stringify(spec),principal.sub),
    await logMutation(db,env.PROJECT_ID,principal,"insight.created",id)
  ]);
  return json({id,name:b.name.trim(),query:spec},201);
}
async function modifyInsight(req:Request,env:ControlEnv,principal:Principal,id:string):Promise<Response>{
  const db=env.META!;
  if(req.method==="DELETE"){
    const result=await db.batch([
      db.prepare("DELETE FROM saved_insights WHERE id=? AND project_id=?").bind(id,env.PROJECT_ID),
      await logMutation(db,env.PROJECT_ID,principal,"insight.deleted",id)
    ]);
    return json({deleted:Number(result[0]?.meta?.changes??0)>0});
  }
  const body=await readBody(req);
  if(!body||typeof body!=="object")return json({error:"invalid_payload"},400);
  const b=body as {name?:unknown;query?:unknown};
  if(!validName(b.name))return json({error:"invalid_name"},400);
  let spec:SavedQuery;
  try{spec=validateSavedQuery(b.query,env);}catch(e){return json({error:String((e as Error).message)},400);}
  const results=await db.batch([
    db.prepare("UPDATE saved_insights SET name=?,query_json=?,updated_at=datetime('now') WHERE id=? AND project_id=?")
      .bind(b.name.trim(),JSON.stringify(spec),id,env.PROJECT_ID),
    await logMutation(db,env.PROJECT_ID,principal,"insight.updated",id)
  ]);
  return json({updated:Number(results[0]?.meta?.changes??0)>0});
}
function parseLayout(input:unknown):unknown[]{
  if(!Array.isArray(input)||input.length>48)throw new Error("invalid_dashboard_layout");
  return input.map(item=>{
    if(!item||typeof item!=="object")throw new Error("invalid_dashboard_layout");
    const x=item as Record<string,unknown>;
    if(typeof x.insightId!=="string"||!idRegex.test(x.insightId)
      ||!Number.isInteger(x.x)||!Number.isInteger(x.y)||!Number.isInteger(x.w)||!Number.isInteger(x.h))
      throw new Error("invalid_dashboard_layout");
    const n=(key:string)=>Number(x[key]);
    if(n("x")<0||n("x")>12||n("y")<0||n("y")>100||n("w")<1||n("w")>12||n("h")<1||n("h")>12)
      throw new Error("invalid_dashboard_layout");
    return {insightId:x.insightId,x:n("x"),y:n("y"),w:n("w"),h:n("h")};
  });
}
export async function handleControl(
  request:Request,env:ControlEnv,principal:Principal
):Promise<Response|null>{
  const url=new URL(request.url),path=url.pathname,method=request.method;
  if(!path.startsWith("/api/insights")&&!path.startsWith("/api/dashboards")&&
    !["/api/sources","/api/query-budget","/api/audit"].includes(path))return null;
  if(!env.META)return json({error:"metadata_not_configured"},503);
  const db=env.META;
  try{
    if(path==="/api/insights"){
      if(method==="GET"){
        const result=await db.prepare(
          "SELECT id,name,query_json,created_by,updated_at FROM saved_insights WHERE project_id=? ORDER BY updated_at DESC LIMIT 100"
        ).bind(env.PROJECT_ID).all<InsightRow>();
        return json({items:result.results.map(x=>({...x,query:JSON.parse(x.query_json),query_json:undefined}))});
      }
      if(method==="POST"){
        if(!isMutationAllowed(request,principal,env))return json({error:"forbidden"},403);
        return createInsight(request,env,principal);
      }
      return json({error:"method_not_allowed"},405);
    }
    const insightId=path.match(/^\/api\/insights\/([A-Za-z0-9_-]{1,128})$/)?.[1];
    const runId=path.match(/^\/api\/insights\/([A-Za-z0-9_-]{1,128})\/run$/)?.[1];
    if(runId && method==="POST"){
      if(request.headers.get("Origin")!==url.origin)return json({error:"origin_not_allowed"},403);
      const row=await db.prepare(
        "SELECT query_json FROM saved_insights WHERE id=? AND project_id=?"
      ).bind(runId,env.PROJECT_ID).first<{query_json:string}>();
      if(!row)return json({error:"not_found"},404);
      const saved=validateSavedQuery(JSON.parse(row.query_json),env);
      return executeBasinQuery(hydrateSavedQuery(saved),env,{principal:principal.sub});
    }
    if(insightId && (method==="PUT"||method==="DELETE")){
      if(!isMutationAllowed(request,principal,env))return json({error:"forbidden"},403);
      return modifyInsight(request,env,principal,insightId);
    }
    if(path==="/api/dashboards"){
      if(method==="GET"){
        const result=await db.prepare(
          "SELECT id,title,layout_json,updated_at FROM dashboards WHERE project_id=? ORDER BY updated_at DESC LIMIT 100"
        ).bind(env.PROJECT_ID).all<{id:string;title:string;layout_json:string;updated_at:string}>();
        return json({items:result.results.map(x=>({id:x.id,title:x.title,layout:JSON.parse(x.layout_json),updatedAt:x.updated_at}))});
      }
      if(method==="POST"){
        if(!isMutationAllowed(request,principal,env))return json({error:"forbidden"},403);
        const body=await readBody(request);
        const b=body as {title?:unknown;layout?:unknown};
        if(!validName(b?.title))return json({error:"invalid_title"},400);
        const layout=parseLayout(b.layout);
        const id=crypto.randomUUID();
        await db.batch([
          db.prepare("INSERT INTO dashboards(id,project_id,title,layout_json) VALUES(?,?,?,?)")
            .bind(id,env.PROJECT_ID,b.title.trim(),JSON.stringify(layout)),
          await logMutation(db,env.PROJECT_ID,principal,"dashboard.created",id)
        ]);
        return json({id,title:b.title,layout},201);
      }
      return json({error:"method_not_allowed"},405);
    }
    const dashboardId=path.match(/^\/api\/dashboards\/([A-Za-z0-9_-]{1,128})$/)?.[1];
    if(dashboardId&&(method==="PUT"||method==="DELETE")){
      if(!isMutationAllowed(request,principal,env))return json({error:"forbidden"},403);
      if(method==="DELETE"){
        const results=await db.batch([
          db.prepare("DELETE FROM dashboards WHERE id=? AND project_id=?").bind(dashboardId,env.PROJECT_ID),
          await logMutation(db,env.PROJECT_ID,principal,"dashboard.deleted",dashboardId),
        ]);
        return json({deleted:Number(results[0]?.meta?.changes??0)>0});
      }
      const body=await readBody(request);
      const b=body as {title?:unknown;layout?:unknown};
      if(!validName(b?.title))return json({error:"invalid_title"},400);
      const layout=parseLayout(b.layout);
      const results=await db.batch([
        db.prepare("UPDATE dashboards SET title=?,layout_json=?,updated_at=datetime('now') WHERE id=? AND project_id=?")
          .bind(b.title.trim(),JSON.stringify(layout),dashboardId,env.PROJECT_ID),
        await logMutation(db,env.PROJECT_ID,principal,"dashboard.updated",dashboardId)
      ]);
      return json({updated:Number(results[0]?.meta?.changes??0)>0});
    }
    if(path==="/api/sources"&&method==="GET"){
      const result=await db.prepare(
        "SELECT id,display_name,enabled,created_at FROM sources WHERE project_id=? LIMIT 100"
      ).bind(env.PROJECT_ID).all();
      return json({items:result.results});
    }
    if(path==="/api/query-budget"&&method==="GET"){
      const period=new Date().toISOString().slice(0,7);
      const row=await db.prepare(
        "SELECT units_used,units_limit FROM query_budgets WHERE project_id=? AND period=?"
      ).bind(env.PROJECT_ID,period).first();
      return json({period,used:row?.units_used??0,limit:row?.units_limit??0});
    }
    if(path==="/api/audit"&&method==="GET"){
      if(!isAdmin(env,principal))return json({error:"forbidden"},403);
      const result=await db.prepare(
        "SELECT id,principal,action,resource_id,created_at FROM audit_log WHERE project_id=? ORDER BY created_at DESC LIMIT 100"
      ).bind(env.PROJECT_ID).all();
      return json({items:result.results});
    }
    return json({error:"method_not_allowed"},405);
  }catch(e){
    if((e as Error).message==="body_too_large")return json({error:"body_too_large"},413);
    if((e as Error).message==="invalid_json")return json({error:"invalid_json"},400);
    if((e as Error).message==="invalid_dashboard_layout")return json({error:"invalid_dashboard_layout"},400);
    console.error("Flightdeck control-plane operation failed",e);
    return json({error:"metadata_unavailable"},503);
  }
}

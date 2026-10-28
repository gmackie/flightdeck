import { compileQuery, estimateQueryUnits, QueryError, type QuerySpec } from "@flightdeck/query";

export interface QueryRuntimeEnv {
  ACCOUNT_ID: string;
  BASIN_BUCKET: string;
  BASIN_TABLE: string;
  PROJECT_ID: string;
  BASIN_SQL_TOKEN: string;
  META?: D1Database;
  QUERY_CACHE?: KVNamespace;
  QUERY_MONTHLY_UNITS?: string;
  QUERY_QUOTA_REQUIRED?: string;
}
type ExecuteOptions = {
  fetcher?: typeof fetch;
  now?: number;
  principal?: string;
};
const json=(body:unknown,status=200):Response=>Response.json(body,{
  status,headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}
});
const period=(now:number)=>new Date(now).toISOString().slice(0,7);
const hash=async(s:string):Promise<string>=>{
  const bytes=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s)));
  return Array.from(bytes,x=>x.toString(16).padStart(2,"0")).join("");
};
function monthlyLimit(env:QueryRuntimeEnv):number {
  const value=Number(env.QUERY_MONTHLY_UNITS??"50000");
  return Number.isSafeInteger(value)&&value>=0&&value<=100_000_000?value:0;
}
/**
 * Atomic D1 quota reservation. A project may overspend Cloudflare billing
 * relative to these units: the units model only admission weight, not bytes.
 */
export async function reserveQueryBudget(
  env:QueryRuntimeEnv,units:number,now=Date.now()
):Promise<"accepted"|"exhausted"|"not_configured"> {
  if (!env.META) return "not_configured";
  const id=period(now),limit=monthlyLimit(env);
  const results=await env.META.batch([
    env.META.prepare(
      "INSERT OR IGNORE INTO query_budgets(project_id,period,units_used,units_limit) VALUES(?,?,0,?)"
    ).bind(env.PROJECT_ID,id,limit),
    env.META.prepare(
      "UPDATE query_budgets SET units_used=units_used+? WHERE project_id=? AND period=? AND units_used+?<=units_limit"
    ).bind(units,env.PROJECT_ID,id,units),
  ]);
  return Number(results[1]?.meta?.changes??0)>0?"accepted":"exhausted";
}
async function writeAudit(env:QueryRuntimeEnv,principal:string,kind:string,units:number,status:string){
  if(!env.META)return;
  try{
    await env.META.prepare(
      "INSERT INTO query_audit(id,project_id,principal,query_kind,units_reserved,status) VALUES(?,?,?,?,?,?)"
    ).bind(crypto.randomUUID(),env.PROJECT_ID,principal.slice(0,128),kind,units,status).run();
  }catch(e){console.error("query audit failed",e);}
}
export async function executeBasinQuery(
  spec:QuerySpec,env:QueryRuntimeEnv,opts:ExecuteOptions={}
):Promise<Response> {
  const now=opts.now??Date.now(),principal=opts.principal??"authenticated";
  if(!env.ACCOUNT_ID||!env.BASIN_BUCKET||!env.BASIN_SQL_TOKEN)return json({error:"query_service_not_configured"},503);
  let query:string;
  try {query=compileQuery(spec,{projectId:env.PROJECT_ID,table:env.BASIN_TABLE},now);}
  catch(e){return json({error:e instanceof QueryError?e.code:"invalid_query"},400);}
  const units=estimateQueryUnits(spec);
  const id=await hash(env.PROJECT_ID+"\n"+query);
  const key="query:"+id;
  // Small bounded cached results can be reused without another SQL call.
  if(env.QUERY_CACHE){
    try{
      const cached=await env.QUERY_CACHE.get(key);
      if(cached)return json({kind:spec.kind,data:JSON.parse(cached),meta:{cached:true,relativeUnits:0}});
    }catch(e){console.error("query cache read failed",e);}
  }
  const required=env.QUERY_QUOTA_REQUIRED!=="false";
  let reservation:"accepted"|"exhausted"|"not_configured";
  try{reservation=await reserveQueryBudget(env,units,now);}
  catch{return json({error:"query_budget_unavailable"},503);}
  if(reservation==="exhausted")return json({error:"query_quota_exceeded",relativeUnits:units},429);
  if(reservation==="not_configured"&&required)return json({error:"query_budget_not_configured"},503);
  const endpoint=`https://api.sql.cloudflarestorage.com/api/v1/accounts/${encodeURIComponent(env.ACCOUNT_ID)}/basin-sql/query/${encodeURIComponent(env.BASIN_BUCKET)}`;
  const fetcher=opts.fetcher??fetch;
  let status="failed",payload:unknown;
  try {
    const response=await fetcher(endpoint,{
      method:"POST",headers:{Authorization:`Bearer ${env.BASIN_SQL_TOKEN}`,"Content-Type":"application/json"},
      body:JSON.stringify({query}),signal:AbortSignal.timeout(20_000),
    });
    if(!response.ok){
      await writeAudit(env,principal,spec.kind,units,"upstream_failed");
      return json({error:"query_upstream_failed",upstreamStatus:response.status},502);
    }
    const content=await response.text();
    if(content.length>2_000_000){
      await writeAudit(env,principal,spec.kind,units,"too_large");
      return json({error:"query_result_too_large"},502);
    }
    payload=JSON.parse(content);
    status="ok";
  }catch{
    await writeAudit(env,principal,spec.kind,units,"unavailable");
    return json({error:"query_upstream_unavailable"},502);
  }
  await writeAudit(env,principal,spec.kind,units,status);
  if(env.QUERY_CACHE){
    try{await env.QUERY_CACHE.put(key,JSON.stringify(payload),{expirationTtl:60});}
    catch(e){console.error("query cache write failed",e);}
  }
  return json({kind:spec.kind,data:payload,meta:{cached:false,relativeUnits:units}});
}

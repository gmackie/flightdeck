import {createRemoteJWKSet,jwtVerify} from "jose";
import {compileQuery,QueryError,type QueryKind,type QuerySpec} from "@flightdeck/query";
import {suggestJourneys,type AIProvider} from "./ai";

interface Env {
  ASSETS: Fetcher;
  ACCESS_TEAM_DOMAIN:string;
  ACCESS_AUD:string;
  ACCOUNT_ID:string;
  BASIN_BUCKET:string;
  BASIN_TABLE:string;
  PROJECT_ID:string;
  BASIN_SQL_TOKEN:string;
  AI?:AIProvider;
  AI_ENABLED?:string;
  AI_MODEL?:string;
}
const jwksCache=new Map<string,ReturnType<typeof createRemoteJWKSet>>();
function json(body:unknown,status=200):Response {
  return Response.json(body,{status,headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
}
async function authorize(request:Request,env:Env):Promise<boolean> {
  const domain=env.ACCESS_TEAM_DOMAIN?.trim();
  if(!domain||!domain.endsWith(".cloudflareaccess.com")||!env.ACCESS_AUD)return false;
  const assertion=request.headers.get("Cf-Access-Jwt-Assertion");
  if(!assertion)return false;
  let keys=jwksCache.get(domain);
  if(!keys){keys=createRemoteJWKSet(new URL(`https://${domain}/cdn-cgi/access/certs`));jwksCache.set(domain,keys);}
  try{
    await jwtVerify(assertion,keys,{issuer:`https://${domain}`,audience:env.ACCESS_AUD,algorithms:["RS256"]});
    return true;
  }catch{return false;}
}
function extractRows(payload:unknown):Record<string,unknown>[] {
  const x=payload as any;
  for(const v of [x?.data?.result?.rows,x?.data?.result?.data,x?.data?.rows,x?.data?.data,x?.data?.result,x?.data]){
    if(Array.isArray(v))return v.filter(r=>r&&typeof r==="object");
  }
  return [];
}
function querySpec(url:URL,kind:QueryKind):QuerySpec {
  const to=url.searchParams.get("to")??new Date().toISOString();
  const from=url.searchParams.get("from")??new Date(Date.now()-30*86_400_000).toISOString();
  const limit=url.searchParams.has("limit")?Number(url.searchParams.get("limit")):undefined;
  return {kind,from,to,...(limit!==undefined?{limit}:{}),
    ...(url.searchParams.get("eventName")?{eventName:url.searchParams.get("eventName")!}:{})};
}
async function queryBasin(spec:QuerySpec,env:Env):Promise<Response> {
  if(!env.ACCOUNT_ID||!env.BASIN_BUCKET||!env.BASIN_SQL_TOKEN)
    return json({error:"query_service_not_configured"},503);
  let query:string;
  try{query=compileQuery(spec,{projectId:env.PROJECT_ID,table:env.BASIN_TABLE});}
  catch(err){return json({error:err instanceof QueryError?err.code:"invalid_query"},400);}
  const endpoint=`https://api.sql.cloudflarestorage.com/api/v1/accounts/${encodeURIComponent(env.ACCOUNT_ID)}/basin-sql/query/${encodeURIComponent(env.BASIN_BUCKET)}`;
  let response:Response;
  try{
    response=await fetch(endpoint,{method:"POST",headers:{
      Authorization:`Bearer ${env.BASIN_SQL_TOKEN}`,"Content-Type":"application/json"
    },body:JSON.stringify({query}),signal:AbortSignal.timeout(15_000)});
  }catch{return json({error:"query_upstream_unavailable"},502);}
  if(!response.ok)return json({error:"query_upstream_failed",upstreamStatus:response.status},502);
  try{return json({kind:spec.kind,data:await response.json()});}
  catch{return json({error:"query_response_invalid"},502);}
}
const mappings:Record<string,QueryKind>={
  "/api/overview":"overview","/api/events":"recent-events","/api/trends":"trends",
  "/api/top-events":"top-events","/api/retention":"retention","/api/experience":"rum",
  "/api/experiments":"experiments","/api/journeys":"transitions",
};
export default {
  async fetch(request:Request,env:Env):Promise<Response> {
    // Fail closed on absent Access config, even for static assets.
    if(!env.ACCESS_TEAM_DOMAIN||!env.ACCESS_AUD)return json({error:"access_not_configured"},503);
    if(!(await authorize(request,env)))return json({error:"unauthorized"},401);
    const url=new URL(request.url);
    if(url.pathname==="/api/config"){
      return json({projectId:env.PROJECT_ID,mode:"basin",selfHosted:true,flagshipManagedExternally:true,aiEnabled:env.AI_ENABLED==="true"});
    }
    if(url.pathname==="/api/discover"){
      if(request.method!=="POST")return json({error:"method_not_allowed"},405);
      if(request.headers.get("Origin")!==url.origin)return json({error:"origin_not_allowed"},403);
      if(env.AI_ENABLED!=="true" || !env.AI)return json({error:"ai_discovery_disabled"},503);
      const queryResponse=await queryBasin(querySpec(url,"transitions"),env);
      if(!queryResponse.ok)return queryResponse;
      const payload:unknown=await queryResponse.json();
      const rows=extractRows(payload);
      if(!rows.length)return json({suggestions:[],reason:"insufficient_transition_data"});
      const suggestions=await suggestJourneys(rows,env.AI,
        env.AI_MODEL||"@cf/meta/llama-3.3-70b-instruct-fp8-fast",true);
      return json({suggestions,source:"aggregated_transitions",causal:false});
    }
    if(url.pathname==="/api/funnel"){
      if(request.method!=="POST")return json({error:"method_not_allowed"},405);
      if(request.headers.get("Origin")!==url.origin)return json({error:"origin_not_allowed"},403);
      const bodyText=await request.text();
      if(bodyText.length>8_192)return json({error:"query_too_large"},413);
      let body:unknown;try{body=JSON.parse(bodyText);}catch{return json({error:"invalid_json"},400);}
      if(!body||typeof body!=="object"||!Array.isArray((body as any).steps))return json({error:"invalid_funnel"},400);
      return queryBasin({kind:"funnel",from:(body as any).from,to:(body as any).to,steps:(body as any).steps},env);
    }
    if(url.pathname.startsWith("/api/")){
      if(request.method!=="GET")return json({error:"method_not_allowed"},405);
      const kind=mappings[url.pathname];
      if(!kind)return json({error:"not_found"},404);
      return queryBasin(querySpec(url,kind),env);
    }
    return env.ASSETS.fetch(request);
  }
} satisfies ExportedHandler<Env>;

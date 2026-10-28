import {createRemoteJWKSet,jwtVerify} from "jose";
import type { QueryKind, QuerySpec } from "@flightdeck/query";
import { executeBasinQuery } from "./query-runtime";
import { handleControl, type ControlEnv, type Principal } from "./control";
import { handleJourneyControl } from "./journey-control";
import { handleGraph } from "./graph";
import { handleInvestigations } from "./investigations";
import { handleExperimentAnalysis } from "./experiment-api";
import { handleAgentHandoff } from "./handoff";
import {suggestJourneys,type AIProvider} from "./ai";

interface Env extends ControlEnv {
  ASSETS: Fetcher;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  AI?: AIProvider;
  AI_ENABLED?: string;
  AI_MODEL?: string;
  JOURNEY_SERVICE?: Fetcher;
  JOURNEY_INTERNAL_KEY?: string;
  AI_INVESTIGATION_DAILY_LIMIT?: string;
  GITHUB_REPOSITORY?: string;
  GITHUB_ISSUES_TOKEN?: string;
}
const jwksCache=new Map<string,ReturnType<typeof createRemoteJWKSet>>();
function json(body:unknown,status=200):Response {
  return Response.json(body,{status,headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
}
async function authorize(request:Request,env:Env):Promise<Principal|null> {
  const domain=env.ACCESS_TEAM_DOMAIN?.trim();
  if(!domain||!domain.endsWith(".cloudflareaccess.com")||!env.ACCESS_AUD)return null;
  const assertion=request.headers.get("Cf-Access-Jwt-Assertion");
  if(!assertion)return null;
  let keys=jwksCache.get(domain);
  if(!keys){keys=createRemoteJWKSet(new URL(`https://${domain}/cdn-cgi/access/certs`));jwksCache.set(domain,keys);}
  try{
    const verified = await jwtVerify(assertion,keys,{issuer:`https://${domain}`,audience:env.ACCESS_AUD,algorithms:["RS256"]});
    const p=verified.payload;
    if(typeof p.sub!=="string" || typeof p.email!=="string")return null;
    return {sub:p.sub,email:p.email};
  }catch{return null;}
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
async function queryBasin(spec:QuerySpec,env:Env,principal:Principal):Promise<Response> {
  return executeBasinQuery(spec,env,{principal:principal.sub});
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
    const principal=await authorize(request,env);
    if(!principal)return json({error:"unauthorized"},401);
    const url=new URL(request.url);
    if(url.pathname.startsWith("/api/")){
      const handoff=await handleAgentHandoff(request,env,principal);
      if(handoff)return handoff;
      const experiment=await handleExperimentAnalysis(request,env,principal.sub);
      if(experiment)return experiment;
      const graph=await handleGraph(request,env);
      if(graph)return graph;
      const investigation=await handleInvestigations(request,env,principal);
      if(investigation)return investigation;
      const journey=await handleJourneyControl(request,env,principal);
      if(journey)return journey;
      const control=await handleControl(request,env,principal);
      if(control)return control;
    }
    if(url.pathname==="/api/config"){
      return json({projectId:env.PROJECT_ID,mode:"basin",selfHosted:true,flagshipManagedExternally:true,aiEnabled:env.AI_ENABLED==="true",queryGovernance:true});
    }
    if(url.pathname==="/api/discover"){
      if(request.method!=="POST")return json({error:"method_not_allowed"},405);
      if(request.headers.get("Origin")!==url.origin)return json({error:"origin_not_allowed"},403);
      if(env.AI_ENABLED!=="true" || !env.AI)return json({error:"ai_discovery_disabled"},503);
      const queryResponse=await queryBasin(querySpec(url,"transitions"),env,principal);
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
      return queryBasin({kind:"funnel",from:(body as any).from,to:(body as any).to,steps:(body as any).steps},env,principal);
    }
    if(url.pathname.startsWith("/api/")){
      if(request.method!=="GET")return json({error:"method_not_allowed"},405);
      const kind=mappings[url.pathname];
      if(!kind)return json({error:"not_found"},404);
      return queryBasin(querySpec(url,kind),env,principal);
    }
    return env.ASSETS.fetch(request);
  }
} satisfies ExportedHandler<Env>;

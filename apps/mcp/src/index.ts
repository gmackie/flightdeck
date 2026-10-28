/**
 * Stateless, read-only Flightdeck MCP tools.
 * This Worker is unreachable until an operator provisions its own Access-
 * protected hostname. Access JWT validation is required even across bindings.
 */
import {McpServer} from "@modelcontextprotocol/server";
import {createMcpHandler} from "agents/mcp/server";
import {z} from "zod";
import {createRemoteJWKSet,jwtVerify} from "jose";

interface Env{
  ACCESS_TEAM_DOMAIN:string;
  ACCESS_AUD:string;
  ADMIN_EMAILS?:string;
  CONSOLE:Fetcher;
}
type Authenticated={id:string;email:string;assertion:string};
const jwks=new Map<string,ReturnType<typeof createRemoteJWKSet>>();
async function authenticate(request:Request,env:Env):Promise<Authenticated|null>{
  const domain=env.ACCESS_TEAM_DOMAIN?.trim(),aud=env.ACCESS_AUD;
  if(!domain||!/^[-a-z0-9]+\.cloudflareaccess\.com$/.test(domain)||!aud)return null;
  const token=request.headers.get("Cf-Access-Jwt-Assertion");
  if(!token)return null;
  let keySet=jwks.get(domain);
  if(!keySet){keySet=createRemoteJWKSet(new URL("https://"+domain+"/cdn-cgi/access/certs"));jwks.set(domain,keySet);}
  try{
    const result=await jwtVerify(token,keySet,{issuer:"https://"+domain,audience:aud,algorithms:["RS256"]});
    if(typeof result.payload.sub!=="string"||typeof result.payload.email!=="string")return null;
    return {id:result.payload.sub,email:result.payload.email,assertion:token};
  }catch{return null;}
}
const response=(value:unknown)=>({
  content:[{type:"text" as const,text:typeof value==="string"?value:JSON.stringify(value)}],
});
async function fromConsole(env:Env,principal:Authenticated,path:string):Promise<unknown>{
  const url="https://flightdeck-console"+path;
  const result=await env.CONSOLE.fetch(url,{
    method:"GET",
    headers:{
      "Cf-Access-Jwt-Assertion":principal.assertion,
      "Accept":"application/json"
    }
  });
  if(!result.ok){
    return {error:"flightdeck_unavailable",status:result.status};
  }
  const raw=await result.text();
  if(raw.length>15_000)
    return {error:"result_exceeds_agent_budget",maxCharacters:15_000};
  try{return JSON.parse(raw);}catch{return {error:"invalid_query_result"};}
}
function adminAllowed(env:Env,principal:Authenticated):boolean{
  return (env.ADMIN_EMAILS??"").toLowerCase().split(",").map(x=>x.trim()).filter(Boolean)
    .includes(principal.email.toLowerCase());
}
async function proposeAdminChange(
  env:Env,principal:Authenticated,operation:unknown,rationale:string
):Promise<unknown>{
  const result=await env.CONSOLE.fetch("https://flightdeck-console/api/admin/requests",{
    method:"POST",
    headers:{
      "Cf-Access-Jwt-Assertion":principal.assertion,
      "Accept":"application/json",
      "Content-Type":"application/json",
      "Origin":"https://flightdeck-console"
    },
    body:JSON.stringify({operation,rationale})
  });
  const raw=await result.text();
  if(raw.length>10000)return {error:"admin_result_exceeds_budget"};
  let body:unknown;try{body=JSON.parse(raw);}catch{return {error:"invalid_admin_response"};}
  if(!result.ok)return {error:"admin_request_rejected",status:result.status,details:body};
  return body;
}
function createServer(env:Env,principal:Authenticated){
  const server=new McpServer({name:"flightdeck",version:"0.1.0"});
  const metricSchema=z.object({days:z.number().int().min(1).max(31).default(7)});
  const timePath=(path:string,days:number)=>{
    const to=new Date(),from=new Date(to.getTime()-days*86_400_000);
    const query=new URLSearchParams({from:from.toISOString(),to:to.toISOString()});
    return path+"?"+query.toString();
  };
  server.registerTool("flightdeck_overview",{
    description:"Read project-scoped event, actor, and session overview metrics from Flightdeck. No raw user data.",
    inputSchema:metricSchema
  },async({days})=>response(await fromConsole(env,principal,timePath("/api/overview",days))));
  server.registerTool("flightdeck_top_events",{
    description:"Read aggregate event counts for the requested historical period.",
    inputSchema:metricSchema
  },async({days})=>response(await fromConsole(env,principal,timePath("/api/top-events",days))));
  server.registerTool("flightdeck_retention",{
    description:"Read bounded daily retention aggregates; not a lifetime acquisition cohort.",
    inputSchema:metricSchema
  },async({days})=>response(await fromConsole(env,principal,timePath("/api/retention",days))));
  server.registerTool("flightdeck_experience",{
    description:"Read aggregate Real User Monitoring metrics and p75 estimates.",
    inputSchema:metricSchema
  },async({days})=>response(await fromConsole(env,principal,timePath("/api/experience",days))));
  server.registerTool("flightdeck_journey_transitions",{
    description:"Read observed event-to-event transition aggregates. Do not interpret them as complete individual paths.",
    inputSchema:metricSchema
  },async({days})=>response(await fromConsole(env,principal,timePath("/api/journeys",days))));
  server.registerTool("flightdeck_graph",{
    description:"Inspect the source-authored application knowledge graph including provenance and confidence.",
    inputSchema:z.object({})
  },async()=>response(await fromConsole(env,principal,"/api/graph")));
  server.registerTool("flightdeck_investigations",{
    description:"List evidence-bound Flightdeck investigations and their review status.",
    inputSchema:z.object({})
  },async()=>response(await fromConsole(env,principal,"/api/investigations")));
  server.registerTool("flightdeck_investigation",{
    description:"Read evidence and review-only proposed actions for one investigation. Does not approve or execute changes.",
    inputSchema:z.object({id:z.string().uuid()})
  },async({id})=>response(await fromConsole(env,principal,"/api/investigations/"+encodeURIComponent(id))));
  server.registerTool("flightdeck_query_budget",{
    description:"View the current project's relative analytics query budget. Units are not actual Cloudflare billing.",
    inputSchema:z.object({})
  },async()=>response(await fromConsole(env,principal,"/api/query-budget")));
  server.registerTool("flightdeck_saved_insights",{
    description:"List metadata for reusable product analytics insight definitions.",
    inputSchema:z.object({})
  },async()=>response(await fromConsole(env,principal,"/api/insights")));
  if(adminAllowed(env,principal)){
    server.registerTool("flightdeck_admin_status",{
      description:"Read private Flightdeck Core/source/Access health for this project. No secrets.",
      inputSchema:z.object({})
    },async()=>response(await fromConsole(env,principal,"/api/admin/overview")));
    server.registerTool("flightdeck_admin_sources",{
      description:"List this project's enabled/disabled Worker and DO source policies; never returns source credentials.",
      inputSchema:z.object({})
    },async()=>response(await fromConsole(env,principal,"/api/admin/sources")));
    server.registerTool("flightdeck_admin_budgets",{
      description:"Read administrator-configured analytics query/AI budgets and current usage (relative units).",
      inputSchema:z.object({})
    },async()=>response(await fromConsole(env,principal,"/api/admin/budgets")));
    server.registerTool("flightdeck_admin_audit",{
      description:"Read recent project administration and approval audit events. No tokens.",
      inputSchema:z.object({})
    },async()=>response(await fromConsole(env,principal,"/api/admin/audit")));
    server.registerTool("flightdeck_admin_pending_changes",{
      description:"List restricted admin change requests with their review status.",
      inputSchema:z.object({})
    },async()=>response(await fromConsole(env,principal,"/api/admin/requests")));
    const sourceChange=z.object({
      sourceId:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
      rationale:z.string().min(12).max(512)
    });
    server.registerTool("flightdeck_admin_propose_disable_source",{
      description:"Propose disabling collection for one source. ONLY CREATES A REVIEW REQUEST; administrator must approve in the UI.",
      inputSchema:sourceChange
    },async({sourceId,rationale})=>response(await proposeAdminChange(env,principal,
      {kind:"source.disable",sourceId},rationale)));
    server.registerTool("flightdeck_admin_propose_enable_source",{
      description:"Propose enabling one Worker/DO source. Does not apply until separately approved in Admin UI.",
      inputSchema:sourceChange
    },async({sourceId,rationale})=>response(await proposeAdminChange(env,principal,
      {kind:"source.enable",sourceId},rationale)));
    server.registerTool("flightdeck_admin_propose_query_budget",{
      description:"Propose a new monthly relative query admission limit, without changing billing or applying it.",
      inputSchema:z.object({units:z.number().int().min(0).max(100000000),
        rationale:z.string().min(12).max(512)})
    },async({units,rationale})=>response(await proposeAdminChange(env,principal,
      {kind:"budget.query",units},rationale)));
    server.registerTool("flightdeck_admin_propose_ai_budget",{
      description:"Propose a new daily AI investigation request limit. Requires Admin UI approval.",
      inputSchema:z.object({dailyLimit:z.number().int().min(0).max(100),
        rationale:z.string().min(12).max(512)})
    },async({dailyLimit,rationale})=>response(await proposeAdminChange(env,principal,
      {kind:"budget.ai",dailyLimit},rationale)));
    server.registerTool("flightdeck_admin_propose_source_policy",{
      description:"Propose a source event allowlist/policy JSON change; never applies directly.",
      inputSchema:z.object({
        sourceId:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
        policyJson:z.string().min(2).max(12000),
        rationale:z.string().min(12).max(512)
      })
    },async({sourceId,policyJson,rationale})=>{
      let policy:unknown;
      try{policy=JSON.parse(policyJson);}catch{return response({error:"invalid_policy_json"});}
      return response(await proposeAdminChange(env,principal,
        {kind:"source.policy",sourceId,policy},rationale));
    });
  }
  return server;
}
export default {
  async fetch(request:Request,env:Env,ctx:ExecutionContext):Promise<Response>{
    const url=new URL(request.url);
    if(url.pathname!=="/mcp")return new Response("Not found",{status:404});
    const principal=await authenticate(request,env);
    if(!principal)return Response.json({error:"unauthorized"},{status:401,headers:{"Cache-Control":"no-store"}});
    // Stateless 2026 MCP handler. No write tools, wildcard CORS or legacy SSE.
    return createMcpHandler(()=>createServer(env,principal),{
      route:"/mcp",corsOptions:false,legacy:"reject",responseMode:"json"
    })(request,env,ctx);
  }
} satisfies ExportedHandler<Env>;

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
  CONSOLE:Fetcher;
  ADMIN_EMAILS?:string;
  ENABLE_ADMIN_MCP_WRITES?:string;
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
async function fromConsole(
  env:Env,principal:Authenticated,path:string,
  method:"GET"|"POST"="GET",payload?:unknown
):Promise<unknown>{
  const url="https://flightdeck-console"+path;
  const result=await env.CONSOLE.fetch(url,{
    method,
    headers:{
      "Cf-Access-Jwt-Assertion":principal.assertion,
      "Accept":"application/json",
      ...(method==="POST"?{
        "Origin":"https://flightdeck-console","Content-Type":"application/json"
      }:{})
    },
    ...(method==="POST"?{body:JSON.stringify(payload??{})}:{})
  });
  if(!result.ok){
    return {error:"flightdeck_unavailable",status:result.status};
  }
  const raw=await result.text();
  if(raw.length>15_000)
    return {error:"result_exceeds_agent_budget",maxCharacters:15_000};
  try{return JSON.parse(raw);}catch{return {error:"invalid_query_result"};}
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
  const adminEmails=(env.ADMIN_EMAILS??"").toLowerCase().split(",").map(x=>x.trim()).filter(Boolean);
  const isAdmin=adminEmails.includes(principal.email.toLowerCase());
  if(isAdmin){
    server.registerTool("flightdeck_admin_status",{
      description:"Read configured Flightdeck health and migration checks. Does not provision resources.",
      inputSchema:z.object({})
    },async()=>response(await fromConsole(env,principal,"/api/admin/status")));
    server.registerTool("flightdeck_admin_sources",{
      description:"List project-scoped sources and their policy without exposing credentials or token digests.",
      inputSchema:z.object({})
    },async()=>response(await fromConsole(env,principal,"/api/admin/sources")));
    if(env.ENABLE_ADMIN_MCP_WRITES==="true"){
      server.registerTool("flightdeck_admin_disable_source",{
        description:"Disable an existing source after explicit operator confirmation. Cannot create credentials or re-enable sources.",
        inputSchema:z.object({
          sourceId:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
          confirm:z.literal("APPLY_DISABLE")
        })
      },async({sourceId,confirm})=>response(await fromConsole(
        env,principal,"/api/admin/sources/"+encodeURIComponent(sourceId)+"/disable",
        "POST",{confirm}
      )));
    }
  }
  server.registerTool("flightdeck_saved_insights",{
    description:"List metadata for reusable product analytics insight definitions.",
    inputSchema:z.object({})
  },async()=>response(await fromConsole(env,principal,"/api/insights")));
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

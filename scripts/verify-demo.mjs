#!/usr/bin/env node
import {parseArgs} from "node:util";
import {randomUUID} from "node:crypto";
import {writeFileSync} from "node:fs";
import {pathToFileURL} from "node:url";

export const demoSources={
  forgegraph:["changeset.created","ci.passed","review.approved","deployment.verified"],
  wafflehouse:["room.created","room.joined","game.started","game.completed"],
};
export function resultRows(value){
  const candidates=[value?.data?.result?.rows,value?.data?.result?.data,value?.data?.rows,
    value?.data?.data,value?.data?.result,value?.result?.rows,value?.rows,value?.data];
  return candidates.find(Array.isArray)??[];
}
function httpsOrigin(value){
  const url=new URL(value);
  if(url.protocol!=="https:"||url.username||url.password||url.search||url.hash||url.pathname!=="/")
    throw new Error("Use an HTTPS origin without a path or credentials");
  return url.origin;
}
export async function verifyDemo({consoleOrigin,origins,cookie,token,timeoutMs=300000,fetcher=fetch,log=console.log}){
  if(!cookie||!token||token.length<32)throw new Error("Set FLIGHTDECK_ACCESS_COOKIE and FLIGHTDECK_DEMO_TOKEN securely");
  consoleOrigin=httpsOrigin(consoleOrigin);
  const consoleRequest=async(path,init={})=>{
    const response=await fetcher(consoleOrigin+path,{...init,redirect:"manual",signal:AbortSignal.timeout(20000),
      headers:{Cookie:`CF_Authorization=${cookie}`,Origin:consoleOrigin,...init.headers}});
    if(!response.ok)throw new Error(`Console ${path.split("?")[0]} returned ${response.status}`);
    return response.json();
  };
  // A down service is never acceptable evidence of successful access control.
  for(const path of ["/index.html","/api/config","/api/health"]){
    const denied=await fetcher(consoleOrigin+path,{redirect:"manual",signal:AbortSignal.timeout(20000)});
    if(![302,303,307,308,401,403].includes(denied.status))throw new Error(`Anonymous ${path}: ${denied.status}`);
  }
  const health=await consoleRequest("/api/health");
  if(health.ok!==true)throw new Error("Authenticated component health failed");
  const runId="demo-"+randomUUID();
  const startedAt=new Date(Date.now()-10000).toISOString();
  const expected=new Set();
  for(const [source,events] of Object.entries(demoSources)){
    const origin=httpsOrigin(origins[source]);
    const unauthorized=await fetcher(origin+"/api/flightdeck-demo",{method:"POST",redirect:"manual",signal:AbortSignal.timeout(20000)});
    if(unauthorized.status!==401)throw new Error(`${source} demo endpoint must reject missing credentials (got ${unauthorized.status})`);
    const response=await fetcher(origin+"/api/flightdeck-demo",{method:"POST",redirect:"manual",signal:AbortSignal.timeout(20000),
      headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({runId,startedAt})});
    if(response.status!==202)throw new Error(`${source} ingestion failed (${response.status})`);
    const receipt=await response.json();
    if(receipt.source!==source||receipt.receipt?.accepted!==events.length||receipt.retry?.accepted!==1||
      receipt.receipt?.durability!=="stream_ingested"||receipt.retry?.durability!=="stream_ingested")
      throw new Error(`${source} did not confirm stream ingestion and duplicate submission`);
    events.forEach((_,i)=>expected.add(`${runId}:${source}:${i}`));
  }
  const from=new Date(Date.parse(startedAt)-1).toISOString();
  const deadline=Date.now()+timeoutMs,begin=Date.now();
  while(true){
    const to=new Date().toISOString();
    const range=`from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const rows=resultRows(await consoleRequest("/api/events?limit=200&"+range));
    const found=rows.filter(row=>expected.has(row.event_id));
    if(found.length===expected.size&&new Set(found.map(row=>row.event_id)).size===expected.size){
      for(const [source,steps] of Object.entries(demoSources)){
        for(let i=0;i<steps.length;i++){
          const row=found.find(row=>row.event_id===`${runId}:${source}:${i}`);
          if(row?.event_name!==steps[i]||row?.actor_id!==`${source}:${runId}`)
            throw new Error("Fixture event identity or event name mismatch");
        }
        const funnel=resultRows(await consoleRequest("/api/funnel",{method:"POST",
          headers:{"Content-Type":"application/json"},body:JSON.stringify({from,to,steps})}));
        if(funnel.length!==steps.length||funnel.some(row=>Number(row.actors)!==1))
          throw new Error(`${source} funnel differs from the single-actor fixture; use a quiet dedicated demo environment`);
      }
      const evidence={ok:true,runId,verifiedAt:new Date().toISOString(),events:expected.size,
        duplicateSubmissions:2,visibilityMs:Date.now()-begin,sources:Object.keys(demoSources),consoleOrigin};
      log(JSON.stringify(evidence,null,2));return evidence;
    }
    if(Date.now()>=deadline)throw new Error(`Timed out waiting for ${expected.size} deduplicated events (found ${found.length})`);
    log(`Waiting for Basin visibility: ${found.length}/${expected.size} events`);
    await new Promise(resolve=>setTimeout(resolve,5000));
  }
}
async function main(){
  const {values}=parseArgs({options:{console:{type:"string"},forgegraph:{type:"string"},wafflehouse:{type:"string"},out:{type:"string"},help:{type:"boolean"}}});
  if(values.help){console.log("node scripts/verify-demo.mjs --console https://CONSOLE --forgegraph https://APP --wafflehouse https://APP [--out evidence.json]\nSecrets: FLIGHTDECK_ACCESS_COOKIE, FLIGHTDECK_DEMO_TOKEN (environment only)");return;}
  const evidence=await verifyDemo({consoleOrigin:values.console,
    origins:{forgegraph:values.forgegraph,wafflehouse:values.wafflehouse},
    cookie:process.env.FLIGHTDECK_ACCESS_COOKIE,token:process.env.FLIGHTDECK_DEMO_TOKEN});
  if(values.out)writeFileSync(values.out,JSON.stringify(evidence,null,2)+"\n",{mode:0o600});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
  main().catch(error=>{console.error(error.message);process.exitCode=1;});

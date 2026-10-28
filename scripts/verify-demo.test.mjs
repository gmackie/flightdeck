import {test} from "node:test";
import assert from "node:assert/strict";
import {verifyDemo,demoSources} from "./verify-demo.mjs";

test("live verifier refuses an unavailable console even when anonymous access is denied",async()=>{
  await assert.rejects(verifyDemo({consoleOrigin:"https://console.example",origins:{},cookie:"test",token:"t".repeat(40),
    log:()=>{},fetcher:async(_url,init)=>new Response(null,{status:init.headers?503:401})}),/returned 503/);
});
test("verifies two source fixtures, duplicate submissions and both funnels",async()=>{
  const rows=[];
  const fetcher=async(url,init={})=>{
    const path=new URL(url).pathname;
    if(!init.headers)return new Response(null,{status:401});
    if(path==="/api/health")return Response.json({ok:true});
    if(path==="/api/events")return Response.json({data:{result:{rows}}});
    if(path==="/api/funnel")return Response.json({data:{result:{rows:[0,1,2,3].map(i=>({actors:1,step_index:i}))}}});
    const source=new URL(url).hostname.split(".")[0];
    const {runId}=JSON.parse(init.body);
    demoSources[source].forEach((event_name,i)=>rows.push({event_id:`${runId}:${source}:${i}`,event_name,actor_id:`${source}:${runId}`}));
    return Response.json({source,receipt:{accepted:4,durability:"stream_ingested"},retry:{accepted:1,durability:"stream_ingested"}},{status:202});
  };
  const evidence=await verifyDemo({consoleOrigin:"https://console.example",origins:{forgegraph:"https://forgegraph.example",wafflehouse:"https://wafflehouse.example"},
    cookie:"test-cookie",token:"t".repeat(40),fetcher,log:()=>{}});
  assert.equal(evidence.events,8);
  assert.equal(evidence.duplicateSubmissions,2);
  assert.equal(JSON.stringify(evidence).includes("test-cookie"),false);
});

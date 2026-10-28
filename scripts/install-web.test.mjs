import {test} from "node:test";
import assert from "node:assert/strict";
import {request as rawHttpRequest} from "node:http";
import {createInstallerServer,validateWebInstall} from "./install-web.mjs";

const account="a".repeat(32);
const input={accountId:account,slug:"demo",adminEmails:"admin@example.com",
 mode:"intelligence",enableAI:false,enableMcp:true,queryUnits:50000};
const testServer=async(work)=>{
 const instance=createInstallerServer({
  secret:"x".repeat(43),accounts:async()=>[{id:account,name:"Team account"}],
  env:{CLOUDFLARE_API_TOKEN:"",FLIGHTDECK_CATALOG_TOKEN:""}
 });
 await new Promise(resolve=>instance.server.listen(0,"127.0.0.1",resolve));
 const port=instance.server.address().port;
 const base="http://127.0.0.1:"+port;
 try{await work({base,secret:instance.secret,state:instance.status});}
 finally{await new Promise(resolve=>instance.server.close(resolve));}
};
test("wizard plan is account-scoped and enumerates full install",()=>{
 const plan=validateWebInstall(input);
 assert.equal(plan.accountId,account);
 assert.match(JSON.stringify(plan.resources),/flightdeck-demo-console/);
 assert.match(JSON.stringify(plan.steps),/Basin/);
 assert.match(JSON.stringify(plan.steps),/Access/);
});
test("localhost wizard rejects invalid slugs and empty administrator allowlist",()=>{
 assert.throws(()=>validateWebInstall({...input,slug:"../evil"}));
 assert.throws(()=>validateWebInstall({...input,adminEmails:""}));
});
test("host, origin and CSRF defenses protect install operations",async()=>{
 await testServer(async({base,secret})=>{
  const invalidHost=await new Promise((resolve,reject)=>{
    const address=new URL(base);
    const request=rawHttpRequest({
      hostname:"127.0.0.1",port:Number(address.port),
      path:"/api/status",method:"GET",
      headers:{"Host":"evil.example","X-Flightdeck-CSRF":secret}
    },response=>{
      response.resume();
      response.on("end",()=>resolve(response.statusCode));
    });
    request.on("error",reject);
    request.end();
  });
  assert.equal(invalidHost,403);
  const missing=await fetch(base+"/api/plan",{method:"POST",
    headers:{"Content-Type":"application/json","Origin":base},
    body:JSON.stringify(input)});
  assert.equal(missing.status,403);
  const evil=await fetch(base+"/api/plan",{method:"POST",
    headers:{"Content-Type":"application/json","Origin":"https://attacker.example",
      "X-Flightdeck-CSRF":secret},
    body:JSON.stringify(input)});
  assert.equal(evil.status,403);
  const valid=await fetch(base+"/api/plan",{method:"POST",headers:{
    "Content-Type":"application/json","Origin":base,"X-Flightdeck-CSRF":secret},
    body:JSON.stringify(input)});
  assert.equal(valid.status,200);
  const result=await valid.json();
  assert.equal(result.plan.slug,"demo");
 });
});
test("web UI serves an embedded nonce and no external credentials",async()=>{
 await testServer(async({base,secret})=>{
  const response=await fetch(base+"/");
  const body=await response.text();
  assert.equal(response.status,200);
  assert.match(body,/Deploy Flightdeck/);
  assert.ok(body.includes(secret));
  assert.match(response.headers.get("Content-Security-Policy"),/script-src 'self'/);
 });
});
test("cannot deploy without explicit confirmation and installer tokens",async()=>{
 await testServer(async({base,secret})=>{
  const invoke=async body=>fetch(base+"/api/install",{method:"POST",
    headers:{"Content-Type":"application/json","Origin":base,"X-Flightdeck-CSRF":secret},
    body:JSON.stringify(body)});
  assert.equal((await invoke({...input,confirmation:"YES"})).status,400);
  const denied=await invoke({...input,confirmation:"INSTALL"});
  assert.equal(denied.status,412);
 });
});

test("account capability endpoint is read-only and rejects permissions before install",async()=>{
 const account="a".repeat(32);
 let preflightCalls=0;
 const server=createInstallerServer({
  secret:"s".repeat(43),
  env:{CLOUDFLARE_API_TOKEN:"a".repeat(40),FLIGHTDECK_CATALOG_TOKEN:"b".repeat(40)},
  accounts:async()=>[{id:account,name:"Team"}],
  preflight:async(plan)=>{
    preflightCalls++;
    if(plan.slug==="blocked")throw new Error("Basin scope missing");
    return {accountId:plan.accountId,checks:[{service:"basin",readable:true}]};
  }
 });
 await new Promise(resolve=>server.server.listen(0,"127.0.0.1",resolve));
 const base="http://127.0.0.1:"+server.server.address().port;
 const post=async path,body=>{
  const res=await fetch(base+path,{method:"POST",headers:{
    "Origin":base,"Content-Type":"application/json","X-Flightdeck-CSRF":server.secret
  },body:JSON.stringify(body)});
  return res;
 };
 try{
  const ok=await post("/api/preflight",{...input,accountId:account});
  assert.equal(ok.status,200);
  const blocked=await post("/api/preflight",{...input,slug:"blocked"});
  assert.equal(blocked.status,412);
  const unauthorized=await post("/api/preflight",{...input,accountId:"f".repeat(32)});
  assert.equal(unauthorized.status,403);
  assert.equal(preflightCalls,2);
 }finally{
  await new Promise(resolve=>server.server.close(resolve));
 }
});

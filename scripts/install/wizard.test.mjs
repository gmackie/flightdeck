import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Manifest,InstallerError} from "./engine.mjs";
import {applyWizard,installationPlan} from "./wizard.mjs";

const account="a".repeat(32);
const streamId="b".repeat(32),sinkId="c".repeat(32),pipelineId="d".repeat(32);
const d1Id="12345678-1234-1234-1234-123456789abc";
class FakeAPI {
 enabled=true;
 accountId=account;
 streams=[];sinks=[];pipelines=[];
 account(path){return "/accounts/"+account+path;}
 async call(path,{method="GET",body}={}){
  if(path.endsWith("/workers/subdomain")){
    if(method==="GET")return {subdomain:"testteam"};
    throw new Error("Wizard must never rename an existing workers.dev subdomain");
  }
  if(path.endsWith("/d1/database"))return method==="POST"?{uuid:d1Id}:[];
  if(path.endsWith("/queues")&&method==="GET")return [];
  if(path.includes("/r2/buckets/"))throw new InstallerError("provider_request_failed","(404)");
  if(path.endsWith("/r2/buckets"))return {name:"flightdeck-test-events"};
  if(path.includes("/r2-catalog/"))return {status:"active"};
  if(path.endsWith("/streams")){
   if(method==="GET")return this.streams;
   this.streams.push({id:streamId,name:body.name});return this.streams.at(-1);
  }
  if(path.endsWith("/sinks")){
   if(method==="GET")return this.sinks;
   assert.equal(body.config.token,"catalog-secret-not-for-manifest");
   assert.equal(body.type,"r2_data_catalog");
   assert.deepEqual(body.format,{type:"parquet",compression:"zstd"});
   this.sinks.push({id:sinkId,name:body.name});return this.sinks.at(-1);
  }
  if(path.endsWith("/pipelines")){
   if(method==="GET")return this.pipelines;
   this.pipelines.push({id:pipelineId,name:body.name});return this.pipelines.at(-1);
  }
  if(path.endsWith("/access/organizations")&&method==="GET")
    throw new InstallerError("provider_request_failed","(404)");
  if(path.endsWith("/access/organizations")&&method==="POST")
    return {auth_domain:"flightdeck-test.cloudflareaccess.com"};
  if(path.endsWith("/access/identity_providers"))return method==="GET"?[]:{id:"provider-created"};
  if(path.endsWith("/access/policies"))return method==="GET"?[]:{id:"policy-created"};
  if(path.endsWith("/access/apps"))return method==="GET"?[]:{id:"app-created",aud:"aud".repeat(10)};
  throw new Error("Unexpected provider API path: "+method+" "+path);
 }
}
class FakeShell {
 env={FLIGHTDECK_CATALOG_TOKEN:"catalog-secret-not-for-manifest"};
 calls=[];
 exec(command,args){
  this.calls.push([command,...args]);
  return {ok:true,stdout:"",stderr:"",status:0};
 }
 wrangler(args){
  this.calls.push(["wrangler",...args]);
  if(args[0]==="basin"&&args[1]==="catalog"&&args[2]==="get")
    return {ok:false,stderr:"404 not found",stdout:"",status:1};
  if(args[0]==="queues"&&args[1]==="list")
    return {ok:true,stdout:"No queues",stderr:"",status:0};
  if(args[0]==="deploy"){
   const filename=args.at(-1);
   const name=filename.includes("console")?"flightdeck-test-console":
     filename.includes("mcp")?"flightdeck-test-mcp":"flightdeck-test-core";
   return {ok:true,stdout:"Published https://"+name+".example.workers.dev",stderr:"",status:0};
  }
  return {ok:true,stdout:"",stderr:"",status:0};
 }
}
test("full install is resumable and keeps credentials out of configs",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"fd-wizard-")),previous=process.cwd();
 try{
  process.chdir(dir);
  mkdirSync("basin",{recursive:true});
  writeFileSync("basin/events.schema.json",JSON.stringify({fields:[
   {name:"event_id",type:"string",required:true}
  ]}));
  const manifest=new Manifest(".flightdeck/install.json"),api=new FakeAPI(),shell=new FakeShell();
  const input={accountId:account,slug:"test",adminEmails:"owner@example.com",
    mode:"intelligence",enableMcp:true};
  const result=await applyWizard({
    input,manifest,shell,api,logger:()=>{},
    fetcher:async()=>new Response("Denied",{status:401})
  });
  assert.equal(result.consoleUrl,"https://flightdeck-test-console.example.workers.dev");
  assert.equal(result.mcpUrl,"https://flightdeck-test-mcp.example.workers.dev/mcp");
  const consoleConfig=JSON.parse(readFileSync("apps/console/wrangler.generated.jsonc","utf8"));
  assert.equal(consoleConfig.assets.run_worker_first,true);
  assert.equal(consoleConfig.vars.ACCESS_AUD,"aud".repeat(10));
  const core=JSON.parse(readFileSync("apps/core/wrangler.generated.jsonc","utf8"));
  assert.equal(core.workers_dev,false);
  assert.equal(core.vars.SOURCE_REGISTRY_MODE,"d1");
  assert.equal(core.pipelines[0].stream,streamId);
  const persisted=JSON.parse(readFileSync(".flightdeck/install.json","utf8"));
  assert.equal(persisted.steps.verified.status,"complete");
  assert.deepEqual(shell.calls[0],["pnpm","build"]);
  assert.equal(result.functionalReadiness,"pending");
  assert.equal(persisted.resources.d1Id,d1Id);
  const serialized=JSON.stringify([consoleConfig,core,persisted]);
  assert.equal(serialized.includes("catalog-secret-not-for-manifest"),false);
  const callsBefore=shell.calls.length;
  await applyWizard({
    input,manifest:new Manifest(".flightdeck/install.json"),shell,api,logger:()=>{},
    fetcher:async()=>new Response("Denied",{status:401})
  });
  const rerun=shell.calls.slice(callsBefore);
  assert.deepEqual(rerun[0],["pnpm","build"]);
  assert.equal(rerun.some(c=>c[0]==="wrangler"&&c[1]==="deploy"),false);
  // Changing deployable input must invalidate deployments and migrations.
  writeFileSync("basin/events.schema.json",JSON.stringify({fields:[
    {name:"event_id",type:"string",required:true},
    {name:"event_name",type:"string",required:true}
  ]}));
  const upgradeStart=shell.calls.length;
  await applyWizard({input,manifest:new Manifest(".flightdeck/install.json"),shell,api,logger:()=>{},
    fetcher:async()=>new Response("Denied",{status:401})});
  const upgrade=shell.calls.slice(upgradeStart);
  assert.ok(upgrade.some(c=>c[0]==="wrangler"&&c[1]==="deploy"));
  assert.ok(upgrade.some(c=>c[0]==="wrangler"&&c[1]==="d1"&&c[2]==="export"));
  assert.ok(upgrade.some(c=>c[0]==="wrangler"&&c[1]==="d1"&&c[2]==="migrations"));
  // Readiness must be checked again, even when no deploy is needed.
  for(const status of [404,503])await assert.rejects(
    applyWizard({input,manifest:new Manifest(".flightdeck/install.json"),shell,api,logger:()=>{},
      fetcher:async()=>new Response("Unavailable",{status})}),
    {code:"console_access_unexpected"});
 }finally{process.chdir(previous);rmSync(dir,{recursive:true,force:true});}
});
test("the installation plan has no public analytics collector",()=>{
 const plan=installationPlan({accountId:account,slug:"test",
  adminEmails:"owner@example.com",mode:"intelligence"});
 assert.equal(plan.steps.some(x=>/public collector/i.test(x)),false);
 assert.equal(plan.steps.some(x=>/Zero Trust Access/i.test(x)),true);
});
test("missing unattended Catalog credential fails before resource creation",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"fd-no-catalog-")),previous=process.cwd();
 try{
  process.chdir(dir);
  const shell=new FakeShell();shell.env={};
  const api=new FakeAPI();
  await assert.rejects(applyWizard({input:{accountId:account,slug:"test",adminEmails:"owner@example.com",mode:"standard"},
   manifest:new Manifest(),shell,api,logger:()=>{}}),/FLIGHTDECK_CATALOG_TOKEN before resources/);
  assert.deepEqual(api.streams,[]);
  assert.equal(shell.calls.some(c=>c.includes("create")||c.includes("deploy")),false);
 }finally{process.chdir(previous);rmSync(dir,{recursive:true,force:true});}
});

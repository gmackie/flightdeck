import {test} from "node:test";
import assert from "node:assert/strict";
import {ensureWorkersSubdomain} from "./cloudflare.mjs";
import {InstallerError} from "./engine.mjs";

const account="a".repeat(32);
function manifest(record={}){
  const state={resources:{...record},steps:{}};
  return {
    resources:state.resources,
    state,
    mark(step,resources){
      Object.assign(state.resources,resources);
      state.steps[step]={status:"complete"};
    }
  };
}
test("reuses existing account-global workers.dev name, without PUT",async()=>{
  const calls=[];
  const api={
    enabled:true,async call(path,opts){
      calls.push({path,method:opts?.method??"GET"});
      return {subdomain:"existing-worker-team"};
    }
  };
  const m=manifest();
  const result=await ensureWorkersSubdomain({api,accountId:account,manifest:m});
  assert.equal(result.workersSubdomain,"existing-worker-team");
  assert.deepEqual(calls.map(c=>c.method),["GET"]);
  assert.equal(m.state.steps.workers_subdomain_created,undefined);
});
test("creates workers.dev once on account without any configured subdomain",async()=>{
  const calls=[];
  let created=false;
  const api={
    enabled:true,async call(path,{method="GET",body}={}){
      calls.push(method);
      if(method==="GET"){
        if(!created)throw new InstallerError("provider_request_failed","Cloudflare returned (404)");
        return {subdomain:"flightdeck-"+account.slice(0,14)};
      }
      assert.equal(method,"PUT");
      assert.equal(body.subdomain,"flightdeck-"+account.slice(0,14));
      created=true;
      return {subdomain:body.subdomain};
    }
  };
  const m=manifest();
  const result=await ensureWorkersSubdomain({api,accountId:account,manifest:m});
  assert.equal(result.workersSubdomain,"flightdeck-"+account.slice(0,14));
  assert.equal(m.state.steps.workers_subdomain_created.status,"complete");
  assert.equal(m.resources.workersSubdomain,result.workersSubdomain);
  const again=await ensureWorkersSubdomain({api,accountId:account,manifest:m});
  assert.equal(again.workersSubdomain,result.workersSubdomain);
  assert.equal(calls.filter(x=>x==="PUT").length,1);
});
test("never replaces recorded account subdomain if another administrator renamed it",async()=>{
 const m=manifest({workersSubdomain:"previous"});
 await assert.rejects(ensureWorkersSubdomain({
   api:{enabled:true,call:async()=>({subdomain:"different"})},
   accountId:account,manifest:m
 }),/changed/);
});
test("missing previously configured hostname fails closed instead of creating new one",async()=>{
 const m=manifest({workersSubdomain:"previous"});
 let writes=0;
 await assert.rejects(ensureWorkersSubdomain({
   api:{enabled:true,call:async(_,{method="GET"}={})=>{
     if(method==="PUT"){writes++;return {subdomain:"new"};}
     throw new InstallerError("provider_request_failed","(404)");
   }},accountId:account,manifest:m
 }),/missing/);
 assert.equal(writes,0);
});
test("permission failure never falls back to account-wide subdomain write",async()=>{
 let writes=0;
 await assert.rejects(ensureWorkersSubdomain({
   api:{enabled:true,call:async(_,{method="GET"}={})=>{
     if(method==="PUT")writes++;
     throw new InstallerError("provider_request_failed","Cloudflare returned (403)");
   }},accountId:account,manifest:manifest()
 }),/403/);
 assert.equal(writes,0);
});

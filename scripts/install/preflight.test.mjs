import {test} from "node:test";
import assert from "node:assert/strict";
import {preflightAccount,PreflightError} from "./preflight.mjs";
const account="a".repeat(32);
function fakeApi({failed=null,subdomain=null}={}){
 const calls=[];
 return {
   enabled:true,calls,
   async call(path){
     calls.push(path);
     if(failed&&path.endsWith(failed))
       throw {code:"provider_request_failed",message:"Cloudflare API denied request (403)"};
     if(path.endsWith("/workers/subdomain")){
       if(!subdomain)throw {code:"provider_request_failed",message:"Cloudflare API resource missing (404)"};
       return {subdomain};
     }
     return [];
   }
 };
}
test("preflight performs read-only checks for all intelligence services",async()=>{
 const api=fakeApi();
 const result=await preflightAccount({api,accountId:account,mode:"intelligence"});
 assert.deepEqual(result.checks.map(x=>x.service),["d1","r2","basin","queues"]);
 assert.equal(api.calls.length,5);
 assert.ok(api.calls.every(x=>x.includes("/accounts/"+account)));
 assert.equal(result.accountId,account);
});
test("preflight tolerates brand-new accounts without a workers.dev subdomain",async()=>{
 const api=fakeApi();
 const result=await preflightAccount({api,accountId:account,mode:"standard"});
 assert.equal(result.checks.length,3);
});
test("preflight rejects missing R2, Basin, or Queue permissions before any mutations",async()=>{
 for(const path of ["/r2/buckets","/pipelines/v1/streams","/queues"]){
   const api=fakeApi({failed:path});
   await assert.rejects(preflightAccount({api,accountId:account,mode:"intelligence"}),
     e=>e instanceof PreflightError);
   assert.ok(api.calls.every(x=>!x.includes("POST")));
 }
});
test("does not treat forbidden Worker-subdomain metadata as a new account",async()=>{
 const api=fakeApi({failed:"/workers/subdomain"});
 await assert.rejects(preflightAccount({api,accountId:account}),
   /Workers account settings not readable/);
});
test("standard mode does not require Queues entitlement",async()=>{
 const api=fakeApi({failed:"/queues",subdomain:"already-set"});
 const result=await preflightAccount({api,accountId:account,mode:"standard"});
 assert.equal(result.checks.length,3);
 assert.equal(api.calls.includes("/accounts/"+account+"/queues"),false);
});

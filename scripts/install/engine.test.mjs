import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,readFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {Manifest,resourceNames,workerHost,validateInstallOptions} from "./engine.mjs";
import {buildConfigs,assertLocked,assertReady} from "./config.mjs";

test("resource names are safe for Basin SQL and workers.dev",()=>{
 const x=resourceNames("qa-install");
 assert.equal(x.core,"flightdeck-qa-install-core");
 assert.match(x.stream,/^[a-z_]+$/);
 assert.match(x.table,/^[a-z_]+$/);
 assert.equal(workerHost("Published https://flightdeck-qa-console.account-name.workers.dev"),
   "flightdeck-qa-console.account-name.workers.dev");
});
test("manifest refuses foreign-account adoption",()=>{
 const dir=mkdtempSync(join(tmpdir(),"fd-install-"));
 try{
  const path=join(dir,"install.json");
  const m=new Manifest(path);m.assertIdentity("a".repeat(32),"team");
  m.mark("d1",{d1Id:"abc"});
  assert.throws(()=>m.assertIdentity("b".repeat(32),"team"),/another account/);
  const state=JSON.parse(readFileSync(path,"utf8"));
  assert.equal(state.resources.d1Id,"abc");
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test("all console assets run the JWT-verifying Worker first",()=>{
 const base={accountId:"a".repeat(32),names:resourceNames("sample"),
  d1Id:"12345678-1234-1234-1234-123456789abc",streamId:"ab123456",
  adminEmails:["owner@example.com"],enableJourneys:true,enableMcp:true};
 const locked=buildConfigs(base);
 assertLocked(locked);
 assert.equal(locked.console.assets.run_worker_first,true);
 assert.equal(locked.core.workers_dev,false);
 assert.equal(locked.journey.workers_dev,false);
 const access={teamDomain:"team.cloudflareaccess.com",aud:"abcdef123456789012345"};
 const ready=buildConfigs({...base,access});
 assertReady(ready,access);
 assert.equal(ready.mcp.vars.ACCESS_AUD,ready.console.vars.ACCESS_AUD);
});
test("invalid account, slug and admin email fail before provider mutation",()=>{
 assert.throws(()=>validateInstallOptions({accountId:"wrong",slug:"test",adminEmails:"a@b.com"}));
 assert.throws(()=>validateInstallOptions({accountId:"a".repeat(32),slug:"../escape",adminEmails:"a@b.com"}));
 assert.throws(()=>validateInstallOptions({accountId:"a".repeat(32),slug:"test",adminEmails:"invalid"}));
});

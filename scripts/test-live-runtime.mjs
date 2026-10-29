#!/usr/bin/env node
// Local-only runtime proof: real Worker RPC, SQLite DO storage and R2 emulation.
import {createRequire} from "node:module";
import {dirname,resolve} from "node:path";
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import assert from "node:assert/strict";
const require=createRequire(import.meta.url);
const {Miniflare,convertV4MiniflareOptions}=await import(require.resolve("miniflare",{paths:[dirname(require.resolve("wrangler/package.json"))]}));
execFileSync("pnpm",["exec","wrangler","deploy","--dry-run","--config","apps/core/wrangler.jsonc","--outdir","../../.wrangler/live-runtime"],{stdio:"pipe"});
const token="local-test-token-"+"a".repeat(32);
const source={projectId:"p1",sha256:createHash("sha256").update(token).digest("hex"),allowedEvents:["session.updated"],allowedProperties:{"session.updated":[]}};
const mf=new Miniflare(convertV4MiniflareOptions({workers:[{
 name:"core",modules:true,scriptPath:resolve(".wrangler/live-runtime/index.js"),compatibilityDate:"2026-10-27",
 bindings:{SINK_MODE:"r2",SOURCE_CREDENTIALS:JSON.stringify({app:source})},
 r2Buckets:["EVENTS"],durableObjects:{LIVE_SESSIONS:{className:"LiveSessions",useSQLite:true}}
},{name:"probe",modules:true,compatibilityDate:"2026-10-27",serviceBindings:{CORE:"core"},
 script:`export default {async fetch(request,env){const x=await request.json();try{return Response.json(x.action==="capture"?await env.CORE.captureBatch(x.request):await env.CORE.liveSessions(x.projectId));}catch{return new Response("rejected",{status:400});}}};`
}]}));
try{
 const worker=await mf.getWorker("probe");
 const send=async body=>worker.fetch("http://local.test/",{method:"POST",body:JSON.stringify(body)});
 const event={eventId:"e1",eventName:"session.updated",sessionId:"s1",actorId:"u1",occurredAt:new Date().toISOString(),objects:[],properties:{}};
 const request={context:{sourceId:"app",sourceToken:token,environment:"staging"},events:[event]};
 const capture=await send({action:"capture",request});assert.equal(capture.status,200);assert.equal((await capture.json()).accepted,1);
 assert.equal((await send({action:"capture",request})).status,200);
 const snapshot=await (await send({action:"snapshot",projectId:"p1"})).json();
 assert.equal(snapshot.enabled,true);assert.equal(snapshot.sessions.length,1);assert.equal(snapshot.sessions[0].events,1);
 assert.equal(snapshot.sessions[0].lastEvent,"session.updated");
 const other=await (await send({action:"snapshot",projectId:"p2"})).json();assert.equal(other.sessions.length,0);
 const rejected=await send({action:"capture",request:{...request,context:{...request.context,sourceToken:"incorrect"},events:[{...event,eventId:"rejected"}]}});
 assert.equal(rejected.status,400);
 const final=await (await send({action:"snapshot",projectId:"p1"})).json();assert.equal(final.retainedEvents,1);
 console.log("Local live-session runtime PASS: accepted event, RPC/storage, duplicate retry, project isolation, unauthorized rejection.");
}finally{await mf.dispose();}

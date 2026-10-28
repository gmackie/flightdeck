import {describe,expect,it,vi} from "vitest";
import {handleAdmin,type AdminEnv,type AdminPrincipal} from "./admin";
const admin:AdminPrincipal={sub:"owner",email:"owner@example.com"};
const viewer:AdminPrincipal={sub:"member",email:"member@example.com"};
const base:AdminEnv={PROJECT_ID:"tenant_a",ADMIN_EMAILS:"owner@example.com"};
const request=(path:string,body:unknown,origin="https://console.example")=>new Request(
  "https://console.example"+path,{
    method:"POST",
    headers:{"Origin":origin,"Content-Type":"application/json"},
    body:JSON.stringify(body)
  }
);
const captureDb=()=>{
 const statements:Array<{query:string;values:unknown[]}>=[],runs=vi.fn(async()=>({meta:{changes:1}}));
 const db={prepare:(query:string)=>({bind:(...values:unknown[])=>{
  statements.push({query,values});
  return {run:runs,first:async()=>null,all:async()=>({results:[]})};
 }})} as unknown as D1Database;
 return {db,statements,runs};
};
describe("Flightdeck admin API",()=>{
 it("keeps all admin endpoints behind Access admin allowlist",async()=>{
  const {db}=captureDb();
  const res=await handleAdmin(new Request("https://console.example/api/admin/sources"),
    {...base,META:db},viewer);
  expect(res?.status).toBe(403);
 });
 it("does not operate without D1",async()=>{
  const res=await handleAdmin(new Request("https://console.example/api/admin/sources"),base,admin);
  expect(res?.status).toBe(503);
 });
 it("rejects cross-origin mutations even with a privileged user",async()=>{
  const {db}=captureDb();
  const r=await handleAdmin(request("/api/admin/sources",{id:"app"}, "https://evil.example"),
    {...base,META:db},admin);
  expect(r?.status).toBe(403);
 });
 it("creates one-time source token but only persists its SHA-256 hash",async()=>{
  const {db,statements}=captureDb();
  const r=await handleAdmin(request("/api/admin/sources",{id:"checkout",displayName:"Checkout"}),
    {...base,META:db},admin);
  expect(r?.status).toBe(201);
  const body=await r?.json() as {token:string;tokenVisibleOnce:boolean};
  expect(body.tokenVisibleOnce).toBe(true);
  expect(body.token.length).toBeGreaterThan(32);
  const insert=statements.find(x=>x.query.includes("INSERT OR IGNORE INTO sources"));
  expect(insert?.values).toBeDefined();
  expect(JSON.stringify(insert?.values).includes(body.token)).toBe(false);
  expect(insert?.values.some(x=>typeof x==="string"&&/^[0-9a-f]{64}$/.test(x))).toBe(true);
  expect(statements.some(x=>JSON.stringify(x.values).includes(body.token))).toBe(false);
 });
 it("rejects executable MCP change requests and accepts a bounded source-disable proposal",async()=>{
  const {db}=captureDb();
  const env={...base,META:db};
  const bad=await handleAdmin(request("/api/admin/requests",{
    operation:{kind:"shell.run",command:"rm -rf /"},
    rationale:"please run whatever"
  }),env,admin);
  expect(bad?.status).toBe(400);
  const good=await handleAdmin(request("/api/admin/requests",{
    operation:{kind:"source.disable",sourceId:"checkout-worker"},
    rationale:"Disable collection during maintenance"
  }),env,admin);
  expect(good?.status).toBe(201);
  expect((await good?.json() as {status:string}).status).toBe("pending");
 });
 it("never allows a stale version to rotate a source secret",async()=>{
  const source={
    id:"checkout",display_name:"Checkout",enabled:1,
    version:4,token_sha256:"a".repeat(64),rotating_sha256_json:"[]",
    policy_json:"{}",created_at:"2026-10-27",updated_at:null
  };
  const db={prepare:(query:string)=>({bind:()=>({
    first:async()=>source,run:async()=>({meta:{changes:1}})
  })})} as unknown as D1Database;
  const r=await handleAdmin(request("/api/admin/sources/checkout/rotate",{
    expectedVersion:3
  }),{...base,META:db},admin);
  expect(r?.status).toBe(409);
 });
});

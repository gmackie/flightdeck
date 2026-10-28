import {describe,expect,it,vi} from "vitest";
import {handleAdmin} from "../../apps/console/src/admin";
import {resolveSources} from "../../apps/core/src/sources";
import {ingestBatch} from "../../apps/core/src/ingest";
import type {CaptureRequest} from "../../packages/contracts/src/index";
const principal={sub:"admin-1",email:"admin@example.com"};
const base="https://analytics.example";
type SourceRow={
 project_id:string;source_id:string;token_sha256:string;
 previous_sha256:string|null;policy_json:string;enabled:number;created_by:string;
};
function database(){
 const map=new Map<string,SourceRow>();
 const metadata:D1Database={
  prepare(query:string){
   return {bind(...args:unknown[]){
    return {
     async first<T>():Promise<T|null>{return null;},
     async all<T>():Promise<{results:T[]}>{
      if(query.includes("FROM source_credentials WHERE source_id=?")){
       const r=map.get(String(args[0]));
       return {results:r?[r as T]:[]};
      }
      return {results:[]};
     },
     async run(){
      if(query.startsWith("INSERT INTO source_credentials")){
       const [project_id,source_id,token_sha256,policy_json,created_by]=args.map(String);
       if(map.has(source_id!))throw new Error("UNIQUE constraint failed");
       map.set(source_id!,{project_id:project_id!,source_id:source_id!,
        token_sha256:token_sha256!,policy_json:policy_json!,created_by:created_by!,
        previous_sha256:null,enabled:1});
       return {meta:{changes:1}};
      }
      if(query.includes("previous_sha256=token_sha256")){
       const [sha,project,source]=args.map(String);
       const row=map.get(source!);
       if(!row||row.project_id!==project||!row.enabled||row.previous_sha256)
        return {meta:{changes:0}};
       row.previous_sha256=row.token_sha256;row.token_sha256=sha!;
       return {meta:{changes:1}};
      }
      if(query.includes("previous_sha256=NULL")){
       const [project,source]=args.map(String),row=map.get(source!);
       if(!row||row.project_id!==project||!row.previous_sha256)return {meta:{changes:0}};
       row.previous_sha256=null;return {meta:{changes:1}};
      }
      if(query.includes("SET enabled=?")){
       const [enabled,project,source]=args,row=map.get(String(source));
       if(!row||row.project_id!==project)return {meta:{changes:0}};
       row.enabled=Number(enabled);return {meta:{changes:1}};
      }
      return {meta:{changes:1}};
     }
    };
   }} as unknown as D1PreparedStatement;
  }
 } as D1Database;
 return {metadata,map};
}
function request(path:string,confirm:string,payload:Record<string,unknown>={}){
 return new Request(base+path,{method:"POST",headers:{
  Origin:base,"Content-Type":"application/json"
 },body:JSON.stringify({...payload,confirm})});
}
describe("Admin-created source private-RPC lifecycle",()=>{
 it("creates hash-only D1 source, validates ingestion, rotates, retires then disables",async()=>{
  const {metadata,map}=database();
  const env={META:metadata,PROJECT_ID:"workspace",ADMIN_EMAILS:"admin@example.com"};
  const policy={
   allowedEvents:["project.created"],allowedProperties:{"project.created":["template"]},
   allowedEnvironments:["production"],allowedKinds:["product"],
   consentRequired:false,graphEnabled:false
  };
  const created=await handleAdmin(
   request("/api/admin/sources","CREATE_SOURCE",{id:"app_one",policy}),env,principal);
  expect(created?.status).toBe(201);
  const payload=await created!.json() as {token:string};
  expect(payload.token).toMatch(/^[0-9a-f]{64}$/);
  expect(map.get("app_one")?.token_sha256).not.toBe(payload.token);
  const captured:CaptureRequest={
   context:{sourceId:"app_one",sourceToken:payload.token,environment:"production"},
   events:[{eventId:"evt_a",eventName:"project.created",occurredAt:new Date().toISOString(),
    objects:[],properties:{template:"blank"}}]
  };
  const seen:string[]=[];
  const run=async(token:string)=>{
   const registry=await resolveSources("app_one",metadata,"{}");
   return ingestBatch({...captured,context:{...captured.context,sourceToken:token}},
    registry,{durability:"stream_ingested",write:async records=>{
     seen.push(...records.map(r=>r.project_id));
    }});
  };
  expect((await run(payload.token)).accepted).toBe(1);
  expect(seen).toEqual(["workspace"]);
  const rotated=await handleAdmin(
   request("/api/admin/sources/app_one/rotate","APPLY_ROTATE"),env,principal);
  expect(rotated?.status).toBe(200);
  const next=(await rotated!.json() as {token:string}).token;
  expect(next).not.toBe(payload.token);
  expect((await run(next)).accepted).toBe(1);
  expect((await run(payload.token)).accepted).toBe(1);
  const second=await handleAdmin(
   request("/api/admin/sources/app_one/rotate","APPLY_ROTATE"),env,principal);
  expect(second?.status).toBe(409);
  expect((await handleAdmin(
   request("/api/admin/sources/app_one/retire-old","APPLY_RETIRE_OLD"),
   env,principal))?.status).toBe(200);
  await expect(run(payload.token)).rejects.toThrow("unauthorized_source");
  expect((await run(next)).accepted).toBe(1);
  expect((await handleAdmin(
   request("/api/admin/sources/app_one/disable","APPLY_DISABLE"),env,principal))?.status).toBe(200);
  await expect(run(next)).rejects.toThrow("source_disabled");
 });
});

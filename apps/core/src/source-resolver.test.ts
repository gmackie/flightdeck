import {describe,expect,it,vi} from "vitest";
import {resolveSources} from "./sources";
import {sha256} from "./ingest";
const secret="x".repeat(40);
function database(rows:unknown[]):D1Database{
 return {prepare:vi.fn(()=>({bind:vi.fn(()=>({all:vi.fn(async()=>({results:rows}))}))}))} as unknown as D1Database;
}
describe("D1-backed private source registry",()=>{
 it("resolves dynamic project identity from D1 rather than RPC context",async()=>{
  const registry=await resolveSources("app",database([{
   project_id:"trusted",token_sha256:await sha256(secret),previous_sha256:null,
   policy_json:JSON.stringify({allowedEvents:["page.viewed"],allowedProperties:{"page.viewed":["route"]}}),
   enabled:1
  }]),"{}");
  expect(registry.app?.projectId).toBe("trusted");
  expect(registry.app?.allowedEvents).toEqual(["page.viewed"]);
 });
 it("never falls through to stale static credential when dynamic record is disabled",async()=>{
  const registry=await resolveSources("app",database([{
   project_id:"trusted",token_sha256:await sha256(secret),previous_sha256:null,
   policy_json:"{}",enabled:0
  }]),JSON.stringify({app:{projectId:"untrusted",sha256:await sha256(secret)}}));
  expect(registry.app?.enabled).toBe(false);
  expect(registry.app?.projectId).toBe("trusted");
 });
 it("rejects ambiguous source IDs across projects",async()=>{
  await expect(resolveSources("app",database([
   {project_id:"a"},{project_id:"b"}
  ]),"{}")).rejects.toThrow("ambiguous_source_id");
 });
});

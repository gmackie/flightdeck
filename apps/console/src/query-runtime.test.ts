import {describe,expect,it,vi} from "vitest";
import {executeBasinQuery,reserveQueryBudget,type QueryRuntimeEnv} from "./query-runtime";

const now=Date.parse("2026-10-28T00:00:00Z");
const spec={kind:"overview" as const,from:"2026-10-27T00:00:00Z",to:"2026-10-28T00:00:00Z"};
const base:QueryRuntimeEnv={
 ACCOUNT_ID:"testaccount",BASIN_BUCKET:"events",BASIN_TABLE:"default.flightdeck_events",
 PROJECT_ID:"tenant_a",BASIN_SQL_TOKEN:"secret",QUERY_MONTHLY_UNITS:"100"
};
function fakeMeta(changes=1):D1Database{
 return {
  batch:vi.fn(async()=>[{meta:{changes:1}},{meta:{changes}}]),
  prepare:vi.fn(()=>({bind:vi.fn(()=>({run:vi.fn(async()=>({meta:{changes:1}}))}))})),
 } as unknown as D1Database;
}
describe("bounded Basin query runtime",()=>{
 it("fails closed without quota database and never contacts SQL API",async()=>{
  const fetcher=vi.fn();
  const response=await executeBasinQuery(spec,base,{now,fetcher});
  expect(response.status).toBe(503);
  expect((await response.json() as {error:string}).error).toBe("query_budget_not_configured");
  expect(fetcher).not.toHaveBeenCalled();
 });
 it("reserves units atomically and refuses exhausted projects",async()=>{
  expect(await reserveQueryBudget({...base,META:fakeMeta(1)},4,now)).toBe("accepted");
  expect(await reserveQueryBudget({...base,META:fakeMeta(0)},4,now)).toBe("exhausted");
 });
 it("passes only compiled SQL to the upstream, never untrusted SQL from HTTP",async()=>{
  const fetcher=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>{
   const body=JSON.parse(String(init?.body));
   expect(body.query).toContain("project_id = 'tenant_a'");
   expect(body.query).toContain("__fd_row = 1");
   return new Response(JSON.stringify({result:{rows:[{events:7}]}}),{status:200});
  });
  const response=await executeBasinQuery(spec,{...base,META:fakeMeta()},{now,fetcher});
  expect(response.status).toBe(200);
  expect(fetcher).toHaveBeenCalledOnce();
  const payload=await response.json() as {meta:{relativeUnits:number};data:unknown};
  expect(payload.meta.relativeUnits).toBeGreaterThan(0);
 });
});

import {describe,expect,it} from "vitest";
import {handleExperimentAnalysis} from "./experiment-api";
import type {QueryRuntimeEnv} from "./query-runtime";
const env:QueryRuntimeEnv={
  ACCOUNT_ID:"acct",BASIN_BUCKET:"bucket",BASIN_TABLE:"default.events",
  PROJECT_ID:"tenant",BASIN_SQL_TOKEN:"secret"
};
describe("experiment analysis endpoint",()=>{
 it("requires verified same-origin request",async()=>{
  const req=new Request("https://analytics.example/api/experiment-analyze",{
    method:"POST",headers:{"Content-Type":"application/json","Origin":"https://untrusted.example"},
    body:"{}"
  });
  expect((await handleExperimentAnalysis(req,env,"user"))?.status).toBe(403);
 });
 it("rejects unsupported time horizons",async()=>{
  const req=new Request("https://analytics.example/api/experiment-analyze",{
    method:"POST",headers:{"Content-Type":"application/json","Origin":"https://analytics.example"},
    body:JSON.stringify({flagKey:"checkout.v2",goalEvent:"purchase.completed",
      controlVariant:"control",treatmentVariant:"treatment",days:200})
  });
  expect((await handleExperimentAnalysis(req,env,"user"))?.status).toBe(400);
 });
});

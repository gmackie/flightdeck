import {describe,expect,it} from "vitest";
import {handleInvestigations,type InvestigationEnv} from "./investigations";
const env:InvestigationEnv={
  ACCOUNT_ID:"account",BASIN_BUCKET:"bucket",BASIN_TABLE:"default.events",
  PROJECT_ID:"tenant_a",BASIN_SQL_TOKEN:"secret",ADMIN_EMAILS:"admin@example.com"
};
const person={sub:"viewer",email:"viewer@example.com"};
describe("investigation safety",()=>{
 it("fails closed without D1",async()=>{
  const result=await handleInvestigations(
    new Request("https://flightdeck.example/api/investigations"),env,person);
  expect(result?.status).toBe(503);
 });
 it("does not intercept unrelated APIs",async()=>{
  expect(await handleInvestigations(new Request("https://flightdeck.example/api/graph"),env,person)).toBeNull();
 });
 it("refuses writes from viewers even with a configured metadata binding",async()=>{
  const request=new Request("https://flightdeck.example/api/investigations",{
    method:"POST",headers:{"Content-Type":"application/json","Origin":"https://flightdeck.example"},
    body:JSON.stringify({question:"What happened to activation?"})
  });
  const result=await handleInvestigations(request,{...env,META:{} as D1Database},person);
  expect(result?.status).toBe(403);
 });
});

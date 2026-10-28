import {describe,expect,it} from "vitest";
import {handleControl,type Principal,type ControlEnv} from "./control";
const principal:Principal={sub:"user",email:"viewer@example.com"};
const env:ControlEnv={
 ACCOUNT_ID:"id",BASIN_BUCKET:"bucket",BASIN_TABLE:"default.events",PROJECT_ID:"tenant",
 BASIN_SQL_TOKEN:"secret",ADMIN_EMAILS:"admin@example.com"
};
describe("Flightdeck metadata control plane",()=>{
 it("does not disclose metadata without D1",async()=>{
  const result=await handleControl(new Request("https://flightdeck.example/api/insights"),env,principal);
  expect(result?.status).toBe(503);
 });
 it("refuses unsupported control-plane paths",async()=>{
  expect(await handleControl(new Request("https://flightdeck.example/api/events"),env,principal)).toBeNull();
 });
});

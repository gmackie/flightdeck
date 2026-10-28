import {describe,expect,it} from "vitest";
import {handleJourneyControl,type JourneyAdminEnv} from "./journey-control";
const env:JourneyAdminEnv={PROJECT_ID:"default",ADMIN_EMAILS:"admin@example.com"};
const admin={sub:"admin-id",email:"admin@example.com"};
describe("approved journey control",()=>{
 it("fails closed without D1 metadata",async()=>{
  const res=await handleJourneyControl(new Request("https://flightdeck.example/api/journey-definitions"),env,admin);
  expect(res?.status).toBe(503);
 });
 it("rejects unrelated APIs",async()=>{
  const res=await handleJourneyControl(new Request("https://flightdeck.example/api/events"),env,admin);
  expect(res).toBeNull();
 });
});

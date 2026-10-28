import {describe,expect,it,vi} from "vitest";
import {adminAllowed,handleAdmin,validateSourcePolicy} from "./admin";
const principal={sub:"admin-1",email:"admin@example.com"};
const env={PROJECT_ID:"sample",ADMIN_EMAILS:"admin@example.com"};
describe("Flightdeck admin API",()=>{
 it("requires a verified admin principal",()=>{
  expect(adminAllowed(env,principal)).toBe(true);
  expect(adminAllowed(env,{sub:"any",email:"viewer@example.com"})).toBe(false);
 });
 it("denies admin routes when D1 is unconfigured",async()=>{
  const response=await handleAdmin(new Request("https://example.com/api/admin/status"),env,principal);
  expect(response?.status).toBe(503);
 });
 it("does not allow non-admin source creation",async()=>{
  const res=await handleAdmin(new Request("https://example.com/api/admin/sources",{
   method:"POST",headers:{Origin:"https://example.com"},
   body:JSON.stringify({id:"new",confirm:"CREATE_SOURCE"})
  }),{...env,META:{} as D1Database},{sub:"other",email:"guest@example.com"});
  expect(res?.status).toBe(403);
 });
 it("never allows broad wildcard event names or malformed property policy",()=>{
  expect(()=>validateSourcePolicy({
   allowedEvents:["*"],allowedProperties:{},consentRequired:false
  })).toThrow("invalid_allowed_events");
  expect(()=>validateSourcePolicy({
   allowedEvents:["page.viewed"],allowedProperties:{"page.viewed":["password and secret"]}
  })).toThrow("invalid_allowed_properties");
 });
 it("allows a minimal explicit source policy",()=>{
  const policy=validateSourcePolicy({
   allowedEvents:["page.viewed","rum.*"],
   allowedProperties:{"page.viewed":["route"],"rum.*":["value"]},
   consentRequired:true
  });
  expect(policy.consentRequired).toBe(true);
  expect(policy.graphEnabled).toBe(false);
 });
});

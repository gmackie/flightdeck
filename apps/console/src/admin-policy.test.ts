import {describe,expect,it} from "vitest";
import {validateSourcePolicy,validateAdminOperation,defaultSourcePolicy} from "./admin-policy";
describe("administrator policy validation",()=>{
 it("creates restrictive defaults",()=>{
  const d=defaultSourcePolicy();
  expect(d.consentRequired).toBe(true);
  expect(d.graphEnabled).toBe(false);
  expect(d.allowedEvents).toContain("page.viewed");
 });
 it("rejects hidden property exfiltration",()=>{
  expect(()=>validateSourcePolicy({...defaultSourcePolicy(),
    allowedProperties:{"page.viewed":["route","api_key"],"rum.*":["value"],"feature.exposed":["variant"]}
  })).toThrow("sensitive_property_key");
 });
 it("never permits shell, deployment, or unrecognized operations",()=>{
  expect(()=>validateAdminOperation({kind:"shell.run",command:"rm -rf /"})).toThrow("operation_not_allowed");
  expect(()=>validateAdminOperation({kind:"budget.query",units:100000001})).toThrow("invalid_query_budget");
 });
 it("permits explicitly bounded admin change requests",()=>{
  expect(validateAdminOperation({kind:"source.disable",sourceId:"checkout-worker"}))
    .toEqual({kind:"source.disable",sourceId:"checkout-worker"});
 });
});

import { describe, expect, it } from "vitest";
import { enforceEventPolicy, enforceBatchPolicy, enforceSourcePolicy } from "./governance";
import type { AnalyticsEvent } from "@flightdeck/contracts";
const baseline: AnalyticsEvent = {
  eventId:"evt_1", eventName:"project.opened", occurredAt:"2026-10-27T00:00:00Z",
  objects:[],properties:{route:"/projects/:id"}
};
describe("ingestion governance", () => {
  it("rejects disabled sources and unsatisfied consent requirements", () => {
    expect(() => enforceSourcePolicy({enabled:false},{sourceId:"a",sourceToken:"x"})).toThrow("source_disabled");
    expect(() => enforceSourcePolicy({consentRequired:true},{sourceId:"a",sourceToken:"x"})).toThrow("consent_required");
    expect(() => enforceSourcePolicy({consentRequired:true},{sourceId:"a",sourceToken:"x",consentGranted:true})).not.toThrow();
  });
  it("checks nested sensitive keys and giant arrays even under a permitted top-level property", () => {
    expect(() => enforceEventPolicy({...baseline,properties:{meta:{access_token:"oops"}}},{})).toThrow("sensitive_property_name");
    expect(() => enforceEventPolicy({...baseline,properties:{meta:Array(129).fill("x")}},{})).toThrow("property_array_too_large");
  });
  it("rejects routes that leak query params or URLs", () => {
    expect(() => enforceEventPolicy({...baseline,properties:{route:"/account?email=a@b.com"}},{})).toThrow("unsafe_route");
    expect(() => enforceEventPolicy({...baseline,properties:{route:"https://example.com"}} ,{})).toThrow("unsafe_route");
  });
  it("does not permit duplicate IDs within a batch", () => {
    expect(() => enforceBatchPolicy([baseline,baseline],{})).toThrow("duplicate_event_id_in_batch");
  });
});

import {describe,expect,it} from "vitest";
import {compileQuery,estimateQueryUnits} from "./index";
const ctx={projectId:"account_1",table:"default.flightdeck_events"};
const window={from:"2026-10-15T00:00:00Z",to:"2026-10-27T00:00:00Z"};
describe("Flagship-linked experiment SQL",()=>{
 it("attributes earliest exposures and later verified goal events",()=>{
  const query={kind:"experiment-analysis" as const,...window,
    flagKey:"checkout.v2",goalEvent:"purchase.completed",
    controlVariant:"control",treatmentVariant:"variant_b"};
  const sql=compileQuery(query,ctx,Date.parse("2026-10-28T00:00:00Z"));
  expect(sql).toContain("project_id = 'account_1'");
  expect(sql).toContain("exposure_rank=1");
  expect(sql).toContain("e.occurred_at>x.exposed_at");
  expect(sql).toContain("PARTITION BY project_id, source_id, event_id");
  expect(estimateQueryUnits(query)).toBeGreaterThan(100);
 });
 it("does not accept SQL or unbounded variant names",()=>{
  expect(()=>compileQuery({kind:"experiment-analysis",...window,
    flagKey:"checkout' OR 1=1",goalEvent:"purchase.completed",controlVariant:"control",
    treatmentVariant:"variant_b"},ctx,Date.parse("2026-10-28T00:00:00Z"))).toThrow("invalid_experiment_query");
 });
});

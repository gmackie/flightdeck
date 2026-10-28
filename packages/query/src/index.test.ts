import {describe,expect,it} from "vitest";
import {compileQuery,QueryError,type QuerySpec} from "./index";
const ctx={projectId:"tenant_a",table:"default.flightdeck_events"};
const now=Date.parse("2026-10-28T00:00:00Z");
const base={from:"2026-10-01T00:00:00Z",to:"2026-10-28T00:00:00Z"};
describe("bounded Basin SQL compiler",()=>{
 it("enforces server-controlled project filtering",()=>{
  const sql=compileQuery({kind:"recent-events",...base,eventName:"project.created"},ctx,now);
  expect(sql).toContain("project_id = 'tenant_a'");
  expect(sql).toContain("event_name = 'project.created'");
  expect(sql).toContain("LIMIT 50");
 });
 it("bounds expensive queries and rejects hostile SQL",()=>{
  expect(()=>compileQuery({kind:"recent-events",...base,eventName:"foo' OR 1=1"},ctx,now)).toThrow("invalid_event_name");
  expect(()=>compileQuery({kind:"recent-events",...base,limit:5000},ctx,now)).toThrow("invalid_limit");
  expect(()=>compileQuery({kind:"top-events",...base},{projectId:"tenant_a",table:"default.events;DROP TABLE x"},now)).toThrow("invalid_query_context");
 });
 it("builds sequential funnel with tenant filters on every step",()=>{
  const sql=compileQuery({kind:"funnel",...base,steps:["signup.completed","project.created","project.activated"]},ctx,now);
  expect(sql).toContain("step_2 AS");
  expect(sql.match(/e.project_id = 'tenant_a'/g)?.length).toBe(2);
  expect(sql).toContain("e.occurred_at >= prev.time");
 });
 it("supports object journey discovery precursors",()=>{
  const sql=compileQuery({kind:"transitions",...base},ctx,now);
  expect(sql).toContain("LEAD(event_name) OVER");
 });
});

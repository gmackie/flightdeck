import {describe,expect,it} from "vitest";
import {compileQuery,estimateQueryUnits,QueryError,type QuerySpec} from "./index";
const ctx={projectId:"tenant_a",table:"default.flightdeck_events"};
const now=Date.parse("2026-10-28T00:00:00Z");
const base={from:"2026-10-01T00:00:00Z",to:"2026-10-28T00:00:00Z"};
describe("bounded Basin SQL compiler",()=>{
  it("enforces server-controlled tenant predicate and query-time event dedupe",()=>{
    const sql=compileQuery({kind:"recent-events",...base,eventName:"project.created"},ctx,now);
    expect(sql).toContain("project_id = 'tenant_a'");
    expect(sql).toContain("PARTITION BY project_id, source_id, event_id");
    expect(sql).toContain("__fd_row = 1");
    expect(sql).toContain("event_name = 'project.created'");
    expect(sql).toContain("LIMIT 50");
  });
  it("bounds expensive queries and rejects hostile SQL",()=>{
    expect(()=>compileQuery({kind:"recent-events",...base,eventName:"foo' OR 1=1"},ctx,now)).toThrow("invalid_event_name");
    expect(()=>compileQuery({kind:"recent-events",...base,limit:5000},ctx,now)).toThrow("invalid_limit");
    expect(()=>compileQuery({kind:"top-events",...base},{projectId:"tenant_a",table:"default.events;DROP TABLE x"},now)).toThrow("invalid_query_context");
    expect(()=>compileQuery({kind:"retention",from:"2026-01-01",to:"2026-10-01"},ctx,now)).toThrow("range_exceeds_budget");
  });
  it("computes conservative query-weight estimates",()=>{
    expect(estimateQueryUnits({kind:"funnel",...base,steps:["signup.completed","project.created"]}))
      .toBeGreaterThan(estimateQueryUnits({kind:"overview",...base}));
  });
  it("builds strictly ordered funnel over deduplicated, tenant-scoped events",()=>{
    const sql=compileQuery({kind:"funnel",...base,steps:["signup.completed","project.created","project.activated"]},ctx,now);
    expect(sql).toContain("step_2 AS");
    expect(sql).toContain("e.occurred_at > prev.time");
    expect(sql).toContain("FROM unique_events");
    expect(sql).toContain("project_id = 'tenant_a'");
  });
  it("computes transitions using de-duplicated events",()=>{
    const sql=compileQuery({kind:"transitions",...base},ctx,now);
    expect(sql).toContain("LEAD(event_name) OVER");
    expect(sql).toContain("unique_events");
  });
});

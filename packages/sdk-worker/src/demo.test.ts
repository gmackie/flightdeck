import {describe,it,expect} from "vitest";
import {createDemoHandler} from "./demo";
import type {AnalyticsEvent} from "@flightdeck/contracts";

describe("synthetic app demo endpoint",()=>{
  const token="t".repeat(40);
  function setup(enabled=true){
    const received:(readonly AnalyticsEvent[])[]=[];
    const handler=createDemoHandler({enabled,token,source:"app",events:["demo.created","demo.completed"],
      capture:async events=>{received.push(events);return {accepted:events.length,rejected:0,batchId:"batch",durability:"stream_ingested",eventIds:events.map(e=>e.eventId)};}});
    return {handler,received};
  }
  const request=(body:object,auth=token)=>new Request("https://app.example/api/flightdeck-demo",{
    method:"POST",headers:{Authorization:`Bearer ${auth}`,"Content-Type":"application/json"},body:JSON.stringify(body)});
  it("is off by default and requires the app-owned secret",async()=>{
    const body={runId:"demo-test",startedAt:new Date().toISOString()};
    expect((await setup(false).handler(request(body))).status).toBe(404);
    expect((await setup().handler(request(body,"wrong"))).status).toBe(401);
  });
  it("rejects arbitrary data and oversized bodies before capture",async()=>{
    const {handler,received}=setup();
    expect((await handler(request({runId:"demo-test",startedAt:new Date().toISOString(),actorId:"forged"}))).status).toBe(400);
    expect((await handler(request({extra:"x".repeat(2000)}))).status).toBe(413);
    expect(received).toHaveLength(0);
  });
  it("submits only server-defined fixtures and repeats one stable event ID",async()=>{
    const {handler,received}=setup();
    const response=await handler(request({runId:"demo-test",startedAt:new Date().toISOString()}));
    expect(response.status).toBe(202);
    expect(received[0]).toHaveLength(2);
    expect(received[1]![0]).toEqual(received[0]![0]);
    expect(received[0]![0]!.actorId).toBe("app:demo-test");
  });
});

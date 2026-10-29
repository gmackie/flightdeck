import {describe,it,expect} from "vitest";
import {updateLiveState,liveSnapshot,LIVE_WINDOW_MS,LIVE_MAX_EVENTS} from "./live-state";
import type {SinkRecord} from "./ingest";
const now=Date.parse("2026-10-28T23:00:00Z");
const row=(overrides:Partial<SinkRecord>={}):SinkRecord=>({event_id:"e1",event_name:"page.viewed",event_kind:"product",
 project_id:"p1",source_id:"app",environment:"staging",session_id:"s1",actor_id:"u1",
 occurred_at:new Date(now).toISOString(),received_at:new Date(now).toISOString(),
 anonymous_id:"",page_view_id:"",interaction_id:"",trace_id:"",deployment_id:"",objects_json:"[]",properties_json:'{"secret":"never copied"}',batch_id:"batch",...overrides});
describe("bounded live session projection",()=>{
 it("deduplicates retries and keeps delayed activity from replacing the latest event",()=>{
  const state=updateLiveState(undefined,"p1",[row(),row(),row({event_id:"e2",event_name:"page.clicked",occurred_at:new Date(now-1000).toISOString()})],now);
  expect(liveSnapshot(state,now).sessions).toEqual([expect.objectContaining({events:2,lastEvent:"page.viewed",lastSeen:new Date(now).toISOString(),firstSeen:new Date(now-1000).toISOString()})]);
  expect(JSON.stringify(state)).not.toContain("never copied");
 });
 it("isolates sessions by source and environment; event IDs are source scoped",()=>{
  const state=updateLiveState(undefined,"p1",[row(),row({source_id:"other"}),row({event_id:"e2",environment:"production"})],now);
  expect(liveSnapshot(state,now).sessions).toHaveLength(3);
  expect(()=>updateLiveState(state,"p2",[],now)).toThrow("live_project_mismatch");
  expect(()=>updateLiveState(state,"p1",[row({project_id:"p2"})],now)).toThrow("live_project_mismatch");
 });
 it("ignores historical imports, missing or invalid session identities and future timestamps",()=>{
  const state=updateLiveState(undefined,"p1",[row({session_id:""}),row({session_id:"x".repeat(129)}),row({occurred_at:new Date(now-LIVE_WINDOW_MS).toISOString()}),row({received_at:"invalid"}),row({occurred_at:new Date(now+300001).toISOString()})],now);
  expect(state.events).toEqual([]);
 });
 it("expires idle events and bounds stored bytes and event/session counts",()=>{
  const records=Array.from({length:600},(_,i)=>row({event_id:"e"+i,session_id:"s"+i}));
  const state=updateLiveState(undefined,"p1",records,now);
  expect(state.events.length).toBeLessThanOrEqual(LIVE_MAX_EVENTS);
  expect(new TextEncoder().encode(JSON.stringify(state)).length).toBeLessThanOrEqual(96000);
  expect(liveSnapshot(state,now).sessions).toHaveLength(100);
  expect(liveSnapshot(state,now+LIVE_WINDOW_MS).sessions).toEqual([]);
  expect(updateLiveState(state,"p1",[],now+LIVE_WINDOW_MS).events).toEqual([]);
 });
});

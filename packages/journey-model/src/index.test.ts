import {describe,expect,it} from "vitest";
import {transition,validateJourney,replayJourney} from "./index";
const d={id:"activation",projectId:"default",objectType:"workspace",version:1,initialState:"created",
  maxDurationDays:30,terminalStates:["activated"],transitions:[
  {from:"created",event:"project.started",to:"configuring"},
  {from:"configuring",event:"project.created",to:"activated"}
]};
const now=Date.parse("2026-10-28T00:00:00Z");
describe("journey machine",()=>{
 it("compiles a deterministic transition sequence",()=>{
  const definition=validateJourney(d);
  expect(transition(definition,"created","project.started")).toBe("configuring");
  expect(transition(definition,"created","project.created")).toBe("created");
  expect(transition(definition,"configuring","project.created")).toBe("activated");
  expect(transition(definition,"activated","project.started")).toBe("activated");
 });
 it("replays out-of-order observations and deduplicates retried messages",()=>{
  const obs=[
   {eventId:"evt_b",sourceId:"one",eventName:"project.created",occurredAt:"2026-10-27T12:00:00Z"},
   {eventId:"evt_a",sourceId:"one",eventName:"project.started",occurredAt:"2026-10-27T11:00:00Z"},
   {eventId:"evt_a",sourceId:"one",eventName:"project.started",occurredAt:"2026-10-27T11:00:00Z"}
  ];
  const result=replayJourney(d,obs,now);
  expect(result.state).toBe("activated");
  expect(result.observedEvents).toBe(2);
  expect(result.appliedTransitions.map(x=>x.to)).toEqual(["configuring","activated"]);
 });
 it("distinguishes same event ID from different sources",()=>{
  const obs=[
   {eventId:"same",sourceId:"one",eventName:"project.started",occurredAt:"2026-10-27T11:00:00Z"},
   {eventId:"same",sourceId:"two",eventName:"project.created",occurredAt:"2026-10-27T12:00:00Z"}
  ];
  expect(replayJourney(d,obs,now).observedEvents).toBe(2);
 });
 it("rejects ambiguity, unreachable nodes and terminal exits",()=>{
  expect(()=>validateJourney({...d,transitions:[d.transitions[0],d.transitions[0]]})).toThrow("ambiguous_transition");
  expect(()=>validateJourney({...d,transitions:[...d.transitions,{from:"unknown",event:"x.y",to:"else"}]})).toThrow("unreachable_state");
  expect(()=>validateJourney({...d,transitions:[...d.transitions,{from:"activated",event:"x.y",to:"created"}]})).toThrow("terminal_state_has_outgoing_transition");
 });
});

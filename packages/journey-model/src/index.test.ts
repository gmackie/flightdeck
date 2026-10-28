import {describe,expect,it} from "vitest";
import {transition,validateJourney} from "./index";
const d={id:"activation",projectId:"default",objectType:"workspace",version:1,initialState:"created",transitions:[
 {from:"created",event:"project.started",to:"configuring"},
 {from:"configuring",event:"project.created",to:"activated"}
]};
describe("journey machine",()=>{
 it("compiles a deterministic transition sequence",()=>{
  const definition=validateJourney(d);
  expect(transition(definition,"created","project.started")).toBe("configuring");
  expect(transition(definition,"created","project.created")).toBe("created");
  expect(transition(definition,"configuring","project.created")).toBe("activated");
 });
 it("rejects ambiguous transitions",()=>{
  expect(()=>validateJourney({...d,transitions:[d.transitions[0],d.transitions[0]]})).toThrow("ambiguous_transition");
 });
});

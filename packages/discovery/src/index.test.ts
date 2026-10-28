import {describe,expect,it} from "vitest";
import {normalizeTransitions,discoverPaths,validateInterpretation,aiPrompt} from "./index";
const data=[
 {from_event:"signup.completed",to_event:"project.opened",transitions:200},
 {from_event:"project.opened",to_event:"project.created",transitions:150},
 {from_event:"project.created",to_event:"project.opened",transitions:10},
];
describe("evidence-first journey discovery",()=>{
 it("produces graph paths without cycles and preserves edge counts",()=>{
  const paths=discoverPaths(data);
  expect(paths[0]?.events).toEqual(["signup.completed","project.opened","project.created"]);
  expect(paths[0]?.minEdgeObservations).toBe(150);
  expect(paths[0]?.evidence.length).toBe(2);
 });
 it("does not trust invalid edge data",()=>{
  expect(normalizeTransitions([{from_event:"DROP TABLE",to_event:"ok",transitions:10}])).toEqual([]);
 });
 it("rejects unsupported AI outputs rather than executing them",()=>{
  expect(()=>validateInterpretation({title:"bad",summary:"x",hypothesis:"x",confidence:"certain"})).toThrow();
  const text=aiPrompt(discoverPaths(data)[0]!);
  expect(text).toContain("uncertainty");
 });
});

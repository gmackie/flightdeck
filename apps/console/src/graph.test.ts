import {describe,expect,it} from "vitest";
import {handleGraph} from "./graph";
describe("graph scope",()=>{
 it("requires metadata and rejects write methods",async()=>{
  const env={PROJECT_ID:"tenant"};
  const missing=await handleGraph(new Request("https://flightdeck.example/api/graph"),env);
  expect(missing?.status).toBe(503);
  const method=await handleGraph(new Request("https://flightdeck.example/api/graph",{method:"POST"}),env);
  expect(method?.status).toBe(405);
 });
 it("returns null for unrelated routes",async()=>{
  expect(await handleGraph(new Request("https://flightdeck.example/api/overview"),{PROJECT_ID:"tenant"})).toBeNull();
 });
});

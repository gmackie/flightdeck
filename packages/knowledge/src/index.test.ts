import {describe,expect,it} from "vitest";
import {validateGraph} from "./index";
const graph={
 revision:"sha-a1",
 nodes:[
  {id:"route:checkout",kind:"route",label:"Checkout"},
  {id:"api:purchase",kind:"api",label:"POST /purchase"},
 ],
 edges:[{from:"route:checkout",to:"api:purchase",relation:"calls",provenance:"source_code"}]
};
describe("application knowledge manifests",()=>{
 it("validates an application graph with explicit provenance",()=>{
  const m=validateGraph(graph);
  expect(m.nodes).toHaveLength(2);
  expect(m.edges[0]?.confidence).toBe(1);
 });
 it("requires evidence for inferred relationships",()=>{
  expect(()=>validateGraph({...graph,edges:[
   {...graph.edges[0],provenance:"inference",confidence:0.7}
  ]})).toThrow("ungrounded_inference");
 });
 it("rejects secrets and dangling edges",()=>{
  expect(()=>validateGraph({...graph,nodes:[
   {...graph.nodes[0],attributes:{apiKey:"secret"}},graph.nodes[1]
  ]})).toThrow("unsafe_attribute");
  expect(()=>validateGraph({...graph,edges:[
   {...graph.edges[0],to:"missing"}
  ]})).toThrow("invalid_edge");
 });
});

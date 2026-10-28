import {describe,expect,it,vi} from "vitest";
import {registerGraph} from "./graph";
import {sha256,type SourceConfig} from "./ingest";
const token="z".repeat(40);
const manifest={
 revision:"code_rev_1",
 nodes:[{id:"route:checkout",kind:"route",label:"Checkout"}],
 edges:[]
};
function database(){
 const prepared:{query:string;args:unknown[]}[]=[];
 const db={
  prepare:(query:string)=>({bind:(...args:unknown[])=>{
   prepared.push({query,args});return {};
  }}),
  batch:vi.fn(async(statements:unknown[])=>statements.map(()=>({success:true}))),
 } as unknown as D1Database;
 return {db,prepared};
}
describe("source-authored application knowledge graph",()=>{
 it("rejects sources not opted in",async()=>{
  const {db}=database();
  const source:SourceConfig={sha256:await sha256(token),projectId:"test",
    allowedEvents:[],allowedProperties:{}};
  await expect(registerGraph({context:{sourceId:"source",sourceToken:token},
    manifest:manifest as any},{source},db)).rejects.toThrow("graph_ingestion_disabled");
 });
 it("only writes nodes after server-side source authentication",async()=>{
  const {db,prepared}=database();
  const source:SourceConfig={sha256:await sha256(token),projectId:"tenant_a",
    graphEnabled:true,allowedEvents:[],allowedProperties:{}};
  const result=await registerGraph({context:{sourceId:"source",sourceToken:token},
    manifest:manifest as any},{source},db);
  expect(result).toMatchObject({projectId:"tenant_a",nodes:1,edges:0,durability:"d1_persisted"});
  expect(prepared.some(x=>x.query.startsWith("INSERT INTO graph_nodes")&&x.args[0]==="tenant_a")).toBe(true);
 });
});

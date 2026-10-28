import {describe,expect,it,vi} from "vitest";
import {createFlightdeck} from "./index";
import {createBrowserEventHandler} from "./handler";
import type {CaptureRequest,CaptureReceipt} from "@flightdeck/contracts";
const receipt:CaptureReceipt={batchId:"batch_1",accepted:1,rejected:0,durability:"stream_ingested",eventIds:["e1"]};
function setup(){
 const captureBatch=vi.fn(async (_request:CaptureRequest)=>receipt);
 const handler=createBrowserEventHandler({
  authenticate:async()=>({id:"real_actor"}),
  client:()=>createFlightdeck({binding:{captureBatch},sourceId:"worker",sourceToken:"z".repeat(40)}),
  policy:{origins:["https://app.example"],events:{"page.viewed":{properties:["route"]}}},
 });
 return {handler,captureBatch};
}
const request=(origin:string,events:unknown)=>new Request("https://app.example/api/analytics",{
 method:"POST",headers:{"Content-Type":"application/json",Origin:origin},body:JSON.stringify({events})});
describe("authenticated first-party forwarding",()=>{
 it("disallows cross-site requests",async()=>{
  const {handler,captureBatch}=setup();
  expect((await handler(request("https://evil.example",[{eventName:"page.viewed",properties:{route:"/"}}]))).status).toBe(403);
  expect(captureBatch).not.toHaveBeenCalled();
 });
 it("overrides forged browser actor and untrusted objects",async()=>{
  const {handler,captureBatch}=setup();
  const res=await handler(request("https://app.example",[{eventName:"page.viewed",actorId:"admin",objects:[{type:"admin"}],properties:{route:"/"} }]));
  expect(res.status).toBe(202);
  const e=captureBatch.mock.calls[0]![0].events[0]!;
  expect(e.actorId).toBe("real_actor");
  expect(e.objects).toEqual([]);
 });
 it("rejects unknown properties and events",async()=>{
  const {handler}=setup();
  expect((await handler(request("https://app.example",[{eventName:"page.viewed",properties:{password:"secret"}}]))).status).toBe(400);
  expect((await handler(request("https://app.example",[{eventName:"other",properties:{}}]))).status).toBe(403);
 });
});

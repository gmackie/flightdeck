import {describe,expect,it,vi} from "vitest";
import {createFlightdeck} from "./index";
import type {CaptureRequest,CaptureReceipt} from "@flightdeck/contracts";
const receipt:CaptureReceipt={batchId:"batch_1",accepted:1,rejected:0,durability:"stream_ingested",eventIds:["abc"]};
describe("worker SDK",()=>{
 it("forwards trusted source context and attaches object references",async()=>{
  const captureBatch=vi.fn(async (_req:CaptureRequest)=>receipt);
  const client=createFlightdeck({binding:{captureBatch},sourceId:"auth_worker",sourceToken:"a".repeat(40)});
  await client.withContext({actorId:"user_1"}).track("project.created",{template:"blank"},{objects:[{type:"project",id:"p_1",role:"target"}]});
  expect(captureBatch).toHaveBeenCalledOnce();
  expect(captureBatch.mock.calls[0]?.[0].context.sourceId).toBe("auth_worker");
  expect(captureBatch.mock.calls[0]?.[0].events[0].actorId).toBe("user_1");
 });
 it("reports binding errors to caller",async()=>{
  const client=createFlightdeck({binding:{captureBatch:async()=>{throw new Error("offline");}},sourceId:"x",sourceToken:"b".repeat(40)});
  await expect(client.track("page.viewed")).rejects.toThrow("offline");
 });
});

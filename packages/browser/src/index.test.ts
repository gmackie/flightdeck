import {describe,expect,it,vi} from "vitest";
import {createBrowserFlightdeck} from "./index";
describe("first-party browser SDK",()=>{
 it("never sends without consent and sends only to app endpoint",async()=>{
  let consent=false;
  const send=vi.fn(async (_url:RequestInfo|URL,_init?:RequestInit)=>new Response("ok",{status:202}));
  const sdk=createBrowserFlightdeck({consent:()=>consent,send,endpoint:"/api/analytics"});
  expect(sdk.track("page.viewed",{})).toBeNull();
  consent=true;
  sdk.track("project.opened",{template:"blank"});
  await sdk.flush();
  expect(send).toHaveBeenCalledOnce();
  expect(send.mock.calls[0]?.[0]).toBe("/api/analytics");
  sdk.reset();
 });
 it("retries transient failure with same event ID",async()=>{
  const send=vi.fn(async (_url:RequestInfo|URL,_init?:RequestInit)=>new Response('ok',{status:202}))
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(new Response("ok",{status:202}));
  const sdk=createBrowserFlightdeck({consent:()=>true,send});
  sdk.track("page.viewed",{route:"/"},{eventId:"stable_event"});
  await expect(sdk.flush()).rejects.toThrow("offline");
  await sdk.flush();
  const first=JSON.parse(String(send.mock.calls[0]?.[1]?.body)).events[0];
  const second=JSON.parse(String(send.mock.calls[1]?.[1]?.body)).events[0];
  expect(first.eventId).toBe(second.eventId);
 });
});

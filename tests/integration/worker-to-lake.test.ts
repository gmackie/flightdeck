import {describe,expect,it,vi} from "vitest";
import {createFlightdeck} from "../../packages/sdk-worker/src/index";
import {createBrowserEventHandler} from "../../packages/sdk-worker/src/handler";
import {createBrowserFlightdeck} from "../../packages/browser/src/index";
import {ingestBatch,sha256,type SinkRecord,type SourceConfig} from "../../apps/core/src/ingest";
import type {CaptureRequest} from "../../packages/contracts/src/index";

describe("first-party Worker/DO to Flightdeck durable sink",()=>{
 it("accepts a verified browser event through the app Worker, preserves server-derived identity and project",async()=>{
  const token="a".repeat(40);
  const source:SourceConfig={
    sha256:await sha256(token),projectId:"trusted_project",enabled:true,
    allowedEvents:["page.viewed"],allowedProperties:{"page.viewed":["route"]}
  };
  const rows:SinkRecord[]=[];
  const binding={
    captureBatch:async(request:CaptureRequest)=>ingestBatch(request,{web_app:source},{
      durability:"stream_ingested",write:async accepted=>{rows.push(...accepted);}
    })
  };
  const fd=createFlightdeck({binding,sourceId:"web_app",sourceToken:token});
  const handler=createBrowserEventHandler({
    authenticate:async(req)=>req.headers.get("x-session")==="valid"?{id:"real_user"}:null,
    client:()=>fd,
    policy:{origins:["https://shop.example"],events:{"page.viewed":{properties:["route"]}}},
    hasConsent:async()=>true,
  });
  const browser=createBrowserFlightdeck({
    endpoint:"/api/analytics",consent:()=>true,
    send:async(_url,init)=>{
      const request=new Request("https://shop.example/api/analytics",{
        method:"POST",headers:{
          "Content-Type":"application/json","Origin":"https://shop.example","x-session":"valid"
        },body:String(init?.body)
      });
      return handler(request);
    }
  });
  browser.track("page.viewed",{route:"/checkout"});
  await browser.flush();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({project_id:"trusted_project",source_id:"web_app",
    actor_id:"real_user",event_name:"page.viewed"});
  expect(JSON.parse(rows[0]!.properties_json)).toEqual({route:"/checkout"});
 });
 it("rejects forged browser identity and unregistered event names before analytics RPC",async()=>{
  const capture=vi.fn();
  const fd=createFlightdeck({binding:{captureBatch:capture},sourceId:"app",sourceToken:"z".repeat(40)});
  const handler=createBrowserEventHandler({
    authenticate:async()=>({id:"server_user"}),client:()=>fd,
    policy:{origins:["https://app.example"],events:{"page.viewed":{properties:["route"]}}}
  });
  const request=new Request("https://app.example/api/analytics",{
    method:"POST",headers:{"Content-Type":"application/json","Origin":"https://app.example"},
    body:JSON.stringify({events:[{eventName:"payment.completed",actorId:"admin",properties:{amount:100000}}]})
  });
  expect((await handler(request)).status).toBe(403);
  expect(capture).not.toHaveBeenCalled();
 });
});

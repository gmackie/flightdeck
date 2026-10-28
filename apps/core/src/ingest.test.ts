import { describe, expect, it, vi } from "vitest";
import { authenticate, ingestBatch, sha256, validateBatch, type SinkRecord, type SourceConfig } from "./ingest";
import type { CaptureRequest } from "@flightdeck/contracts";
const secret="a".repeat(40), now=Date.parse("2026-10-28T00:00:00Z");
const config:SourceConfig={
  projectId:"project_1",sha256:"",allowedEvents:["project.created","rum.*"],
  allowedProperties:{"project.created":["template"],"rum.*":["value"]},
};
function batch():CaptureRequest {
  return {context:{sourceId:"worker_a",sourceToken:secret},
    events:[{eventId:"e_123",eventName:"project.created",occurredAt:new Date(now).toISOString(),
      objects:[{type:"project",id:"p1",role:"target"}],properties:{template:"blank"},actorId:"user_123"}]};
}
describe("private service-bound ingestion",()=>{
  it("hashes and authenticates tenant-bound sources",async()=>{
    const source={...config,sha256:await sha256(secret)};
    expect(await authenticate(batch().context,{worker_a:source})).toEqual(source);
    await expect(authenticate({...batch().context,sourceToken:"incorrect"},{worker_a:source})).rejects.toMatchObject({code:"unauthorized_source"});
    await expect(authenticate({...batch().context,sourceId:"unknown"},{worker_a:source})).rejects.toMatchObject({code:"unauthorized_source"});
  });
  it("persists authorized normalized events before receipt",async()=>{
    const source={...config,sha256:await sha256(secret)};
    const records:SinkRecord[][]=[];
    const receipt=await ingestBatch(batch(),{worker_a:source},{
      durability:"stream_ingested",write:async rows=>{records.push([...rows]);}
    },now);
    expect(receipt.accepted).toBe(1);
    expect(receipt.durability).toBe("stream_ingested");
    expect(records[0]?.[0]).toMatchObject({project_id:"project_1",source_id:"worker_a",actor_id:"user_123",event_name:"project.created"});
    expect(JSON.parse(records[0]![0]!.objects_json)[0].id).toBe("p1");
  });
  it("does not acknowledge a failed durable sink",async()=>{
    const source={...config,sha256:await sha256(secret)};
    await expect(ingestBatch(batch(),{worker_a:source},{
      durability:"stream_ingested",write:async()=>{throw new Error("sink offline");}
    },now)).rejects.toThrow("sink offline");
  });
  it("rejects unregistered names, properties, and future timestamps",()=>{
    const unknown={...batch().events[0]!,eventName:"other.event"};
    expect(()=>validateBatch({events:[unknown]},config,now)).toThrow("event_not_allowed");
    const extra={...batch().events[0]!,properties:{email:"private@example.com"}};
    expect(()=>validateBatch({events:[extra]},config,now)).toThrow("property_not_allowed");
    const future={...batch().events[0]!,occurredAt:new Date(now+86_400_000).toISOString()};
    expect(()=>validateBatch({events:[future]},config,now)).toThrow("invalid_timestamp");
  });
});

describe("credential rotation and disabled sources",()=>{
  it("accepts overlapping hashes while denying disabled or nonconsenting sources",async()=>{
    const source={...config,sha256:await sha256("b".repeat(40)),rotatingSha256:[await sha256(secret)]};
    const accepted=await authenticate(batch().context,{worker_a:source});
    expect(accepted.projectId).toBe("project_1");
    await expect(authenticate(batch().context,{worker_a:{...source,enabled:false}}))
      .rejects.toMatchObject({code:"source_disabled"});
    await expect(authenticate(batch().context,{worker_a:{...source,consentRequired:true}}))
      .rejects.toMatchObject({code:"consent_required"});
  });
  it("rejects duplicate identifiers and sensitive nested properties",()=>{
    expect(()=>validateBatch({events:[...batch().events,...batch().events]},config,now))
      .toThrow("duplicate_event_id_in_batch");
    const e={...batch().events[0]!,properties:{template:{password:"secret"}}};
    expect(()=>validateBatch({events:[e]},config,now))
      .toThrow("sensitive_property_name");
  });
});

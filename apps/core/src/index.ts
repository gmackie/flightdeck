import { WorkerEntrypoint } from "cloudflare:workers";
import { registerGraph, type GraphSubmission } from "./graph";
import type { GraphReceipt } from "@flightdeck/knowledge";
import type { CaptureRequest, CaptureReceipt } from "@flightdeck/contracts";
import { IngestError, ingestBatch, type SourceConfig, type SinkRecord, type EventSink } from "./ingest";
import { basinSink, r2Sink, type BasinBinding, type R2Like } from "./sinks";

export interface Env {
  /** Never public. Secret JSON source registry with SHA-256 token hashes. */
  SOURCE_CREDENTIALS: string;
  /** basin (recommended) or r2 (small-scale development fallback). */
  SINK_MODE: string;
  STREAM?: BasinBinding;
  EVENTS?: R2Like;
  META?: D1Database;
  /** Optional at-least-once live path, not atomic with the historical sink. */
  JOURNEY_QUEUE?: { sendBatch(messages: ReadonlyArray<{body:SinkRecord}>): Promise<void> };
}
export async function resolveSources(
  sourceId:string, db:D1Database|undefined, registry:string
):Promise<Record<string,SourceConfig>>{
  if(db){
    const record=await db.prepare(
      "SELECT project_id,token_sha256,previous_sha256,policy_json,enabled FROM source_credentials WHERE source_id=? LIMIT 2"
    ).bind(sourceId).all<{
      project_id:string;token_sha256:string;previous_sha256:string|null;
      policy_json:string;enabled:number
    }>();
    if(record.results.length>1)throw new IngestError("ambiguous_source_id");
    const row=record.results[0];
    if(row){
      const policy=JSON.parse(row.policy_json) as Partial<SourceConfig>;
      return {[sourceId]:{
        ...policy,projectId:row.project_id,sha256:row.token_sha256,
        rotatingSha256:row.previous_sha256?[row.previous_sha256]:[],
        enabled:row.enabled===1,
        allowedEvents:policy.allowedEvents??[],
        allowedProperties:policy.allowedProperties??{}
      }};
    }
  }
  return readSources(registry);
}
function readSources(serialized: string): Record<string,SourceConfig> {
  try {
    const value: unknown = JSON.parse(serialized);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string,SourceConfig>;
  } catch { throw new IngestError("source_configuration_missing"); }
}
export default class AnalyticsCore extends WorkerEntrypoint<Env> {
  async captureBatch(request: CaptureRequest): Promise<CaptureReceipt> {
    const mode = this.env.SINK_MODE;
    const sink = mode === "basin" && this.env.STREAM ? basinSink(this.env.STREAM)
      : mode === "r2" && this.env.EVENTS ? r2Sink(this.env.EVENTS)
      : undefined;
    if (!sink) throw new IngestError("sink_not_configured");
    const queue = this.env.JOURNEY_QUEUE;
    const effective: EventSink = queue ? {
      durability: sink.durability,
      write: async (records) => {
        await sink.write(records);
        // Historical stream is authoritative. Queue is optional and independently retried.
        this.ctx.waitUntil(queue.sendBatch(records.map(body => ({body}))).catch(err => {
          console.error("Flightdeck journey delivery failed; history remains authoritative", err);
        }));
      }
    } : sink;
    const registry=await resolveSources(request?.context?.sourceId??"",this.env.META,this.env.SOURCE_CREDENTIALS);
    return ingestBatch(request,registry,effective);
  }
  async registerGraph(request:GraphSubmission):Promise<GraphReceipt> {
    if(!this.env.META)throw new IngestError("metadata_not_configured");
    const registry=await resolveSources(request?.context?.sourceId??"",this.env.META,this.env.SOURCE_CREDENTIALS);
    return registerGraph(request,registry,this.env.META);
  }
  /** Never serve ingestion over public HTTP; use RPC from a service binding. */
  override async fetch(): Promise<Response> {
    return new Response("Not found", {status:404});
  }
}

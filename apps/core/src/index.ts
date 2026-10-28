import { WorkerEntrypoint } from "cloudflare:workers";
import type { CaptureRequest, CaptureReceipt } from "@flightdeck/contracts";
import { IngestError, ingestBatch, type SourceConfig } from "./ingest";
import { basinSink, r2Sink, type BasinBinding, type R2Like } from "./sinks";

export interface Env {
  /** Never public. Secret JSON source registry with SHA-256 token hashes. */
  SOURCE_CREDENTIALS: string;
  /** basin (recommended) or r2 (small-scale development fallback). */
  SINK_MODE: string;
  STREAM?: BasinBinding;
  EVENTS?: R2Like;
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
    return ingestBatch(request,readSources(this.env.SOURCE_CREDENTIALS),sink);
  }
  /** Never serve ingestion over public HTTP; use RPC from a service binding. */
  override async fetch(): Promise<Response> {
    return new Response("Not found", {status:404});
  }
}

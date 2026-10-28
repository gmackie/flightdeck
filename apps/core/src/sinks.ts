import type { EventSink, SinkRecord } from "./ingest";

export interface BasinBinding {
  send(records: readonly SinkRecord[]): Promise<void>;
}
export interface R2Like {
  put(key: string, value: string, options?: {httpMetadata?:{contentType?:string}}): Promise<unknown>;
}
/** A first-class production path. Resolves after Basin stream accepts the records. */
export function basinSink(stream: BasinBinding): EventSink {
  return { durability:"stream_ingested", write: records => stream.send(records) };
}
/** Development fallback; N R2 writes are NOT an atomic batch. */
export function r2Sink(bucket: R2Like): EventSink {
  return {
    durability:"r2_persisted",
    async write(records) {
      for (const record of records) {
        const key = [
          "events",encodeURIComponent(record.project_id),record.occurred_at.slice(0,10),
          encodeURIComponent(record.event_id)+".json",
        ].join("/");
        await bucket.put(key,JSON.stringify(record),{httpMetadata:{contentType:"application/json"}});
      }
    },
  };
}

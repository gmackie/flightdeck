import type {EventSink,SinkRecord} from "./ingest";
/** Optional projections cannot change the canonical sink's receipt or durability. */
export function withLiveSink(sink:EventSink,publish:(records:readonly SinkRecord[])=>Promise<void>,onError:()=>void):EventSink{
 return {durability:sink.durability,write:async records=>{
  await sink.write(records);
  try{await publish(records);}catch{onError();}
 }};
}

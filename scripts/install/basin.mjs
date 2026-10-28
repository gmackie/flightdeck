/**
 * Account-owned resource provisioning. Prefer explicit Cloudflare REST calls
 * when CLOUDFLARE_API_TOKEN and FLIGHTDECK_CATALOG_TOKEN are present. Otherwise
 * delegate the one token-sensitive Basin step to Wrangler's official wizard.
 */
import {readFileSync} from "node:fs";
import {randomBytes} from "node:crypto";
import {normalizeList,InstallerError} from "./engine.mjs";

function is404(e){return e?.code==="provider_request_failed"&&/\(404\)/.test(e.message);}
function requireId(value,label){
  if(typeof value?.id!=="string"||value.id.length<6)
    throw new InstallerError("provider_invalid_result",label+" did not return a valid resource ID.");
  return value.id;
}
function onlyOwned(name,found,recordedId,label){
  if(found&&!recordedId)throw new InstallerError("unowned_resource",
    label+" '"+name+"' already exists and is not tracked by Flightdeck. Choose another installation name.");
  if(found&&recordedId&&found.id!==recordedId)
    throw new InstallerError("resource_identity_mismatch",label+" was replaced; stop and inspect the account.");
}
export async function ensureR2Bucket({api,shell,names,manifest}){
  const accountId=api.accountId,expected=manifest.resources.bucketName;
  if(expected&&expected!==names.bucket)throw new InstallerError("bucket_name_mismatch");
  if(api.enabled){
    let current;
    try{current=await api.call(api.account("/r2/buckets/"+names.bucket));}
    catch(e){if(!is404(e))throw e;}
    if(current){
      if(!expected)throw new InstallerError("unowned_bucket",
        "An R2 bucket with this installation name already exists. Recover its manifest or choose another name.");
    }else{
      await api.call(api.account("/r2/buckets"),{method:"POST",body:{name:names.bucket}});
      manifest.mark("bucket_created",{bucketName:names.bucket});
    }
  }else{
    const list=shell.cfJSON(["r2","buckets","list"]);
    const buckets=normalizeList(list);
    if(buckets.some(b=>b.name===names.bucket)){
      if(!expected)throw new InstallerError("unowned_bucket",
        "An R2 bucket with this name already exists. Recover its install manifest.");
    }else{
      shell.wrangler(["r2","bucket","create",names.bucket]);
      manifest.mark("bucket_created",{bucketName:names.bucket});
    }
  }
  return {bucketName:names.bucket};
}
export async function ensureCatalog({api,shell,names}){
  if(api?.enabled){
    const path=api.account("/r2-catalog/"+names.bucket);
    let catalog;
    try{catalog=await api.call(path);}catch(e){if(!is404(e))throw e;}
    if(catalog?.status!=="active")await api.call(path+"/enable",{method:"POST"});
    return {catalogBucket:names.bucket};
  }
  const probe=shell.wrangler(["basin","catalog","get",names.bucket],{allowFailure:true});
  const missing=/not.?found|404|not enabled|does not exist/i.test(probe.stderr+" "+probe.stdout);
  if(!probe.ok||missing){
    if(!missing)
      throw new InstallerError("catalog_probe_failed","Could not inspect the selected Basin Catalog.");
    shell.wrangler(["basin","catalog","enable",names.bucket]);
  }
  return {catalogBucket:names.bucket};
}
export async function ensureD1({api,shell,names,manifest}){
  const existingId=manifest.resources.d1Id;
  let result;
  if(api.enabled){
    result=normalizeList(await api.call(api.account("/d1/database")));
  }else{
    result=normalizeList(shell.wranglerJSON(["d1","list","--json"]));
  }
  let database=result.find(d=>d.name===names.database);
  if(database){
    const id=database.uuid??database.id;
    if(!existingId||id!==existingId)throw new InstallerError("unowned_d1",
      "A D1 database with this name already exists but is not owned by this manifest.");
  }else{
    if(existingId)throw new InstallerError("missing_d1",
      "The previously recorded D1 database is missing. Never recreate silently.");
    if(api.enabled)database=await api.call(api.account("/d1/database"),{
      method:"POST",body:{name:names.database}
    });
    else{
      shell.wrangler(["d1","create",names.database]);
      const updated=normalizeList(shell.wranglerJSON(["d1","list","--json"]));
      database=updated.find(d=>d.name===names.database);
    }
  }
  const id=database?.uuid??database?.id;
  if(typeof id!=="string"||!/^[a-f0-9-]{32,36}$/i.test(id))
    throw new InstallerError("d1_id_missing","D1 did not provide a UUID.");
  manifest.mark("d1_created",{d1Id:id,d1Name:names.database});
  return {d1Id:id,d1Name:names.database};
}
export async function ensureBasin({api,shell,names,manifest,prompt,logger=console.log}){
  const recorded=manifest.resources.streamId;
  if(recorded && manifest.resources.pipelineId)return {
    streamId:recorded,sinkId:manifest.resources.sinkId,
    pipelineId:manifest.resources.pipelineId,
    basinMode:manifest.resources.basinMode
  };
  const catalogToken=shell.env.FLIGHTDECK_CATALOG_TOKEN;
  if(api.enabled&&typeof catalogToken==="string"&&catalogToken.length>=20){
    // Full unattended path, no credential in process argv or local disk.
    const schema=JSON.parse(readFileSync("basin/events.schema.json","utf8"));
    const base=api.account("/pipelines/v1");
    const streams=normalizeList(await api.call(base+"/streams"));
    const existing=streams.find(s=>s.name===names.stream);
    let streamId=manifest.resources.streamId;
    if(!streamId){
      if(existing)throw new InstallerError("unowned_basin_stream",
        "Named Basin stream exists without an installation record.");
      const stream=await api.call(base+"/streams",{method:"POST",body:{
        name:names.stream,format:{type:"json",unstructured:false},
        schema:{fields:schema.fields},worker_binding:{enabled:true},
        http:{enabled:false,authentication:true},
      }});
      streamId=requireId(stream,"Basin stream");
      manifest.mark("basin_stream",{streamId,basinMode:"api"});
    }else if(!existing||existing.id!==streamId){
      throw new InstallerError("basin_stream_drift","Previously provisioned stream missing or replaced");
    }
    const sinks=normalizeList(await api.call(base+"/sinks"));
    const priorSink=sinks.find(s=>s.name===names.sink);
    let sinkId=manifest.resources.sinkId;
    if(!sinkId){
      if(priorSink)throw new InstallerError("unowned_basin_sink","Named Basin sink exists without install record.");
      const sink=await api.call(base+"/sinks",{method:"POST",body:{
        name:names.sink,type:"r2_data_catalog",
        format:{type:"parquet",compression:"zstd"},
        config:{
          token:catalogToken,bucket:names.bucket,
          namespace:"default",table_name:names.table,
          rolling_policy:{interval_seconds:60,file_size_bytes:100_000_000},
        },
      }});
      sinkId=requireId(sink,"Basin Catalog sink");
      manifest.mark("basin_sink",{sinkId});
    }else if(!priorSink||priorSink.id!==sinkId){
      throw new InstallerError("basin_sink_drift","Previously provisioned sink missing or replaced");
    }
    const pipelines=normalizeList(await api.call(base+"/pipelines"));
    const priorPipeline=pipelines.find(p=>p.name===names.pipeline);
    let pipelineId=manifest.resources.pipelineId;
    if(!pipelineId){
      if(priorPipeline)throw new InstallerError("unowned_basin_pipeline","Named pipeline exists without record.");
      const pipeline=await api.call(base+"/pipelines",{method:"POST",body:{
        name:names.pipeline,sql:"INSERT INTO "+names.sink+" SELECT * FROM "+names.stream,
      }});
      pipelineId=requireId(pipeline,"Basin pipeline");
      manifest.mark("basin_pipeline",{pipelineId});
    }else if(!priorPipeline||priorPipeline.id!==pipelineId){
      throw new InstallerError("basin_pipeline_drift","Previously provisioned pipeline missing or replaced");
    }
    return {streamId,sinkId,pipelineId,basinMode:"api"};
  }
  if(!prompt)throw new InstallerError("basin_token_required",
    "Unattended install needs CLOUDFLARE_API_TOKEN and FLIGHTDECK_CATALOG_TOKEN.");
  logger("Cloudflare Basin setup will now open its native interactive stream/sink/pipeline wizard.");
  logger("Use schema file: basin/events.schema.json");
  logger("Select: HTTP ingestion disabled, Basin Catalog/Iceberg, R2 bucket "+names.bucket+
    ", namespace default, table "+names.table+", simple SQL transform.");
  logger("Cloudflare will request an R2 Catalog token inside its own wizard.");
  shell.interactive("pnpm",["exec","wrangler","basin","pipelines","setup","--name",names.pipeline]);
  const candidate=String(await prompt("Paste the Stream ID displayed by Wrangler (not pipeline ID)","")).trim();
  if(!/^[a-zA-Z0-9_-]{4,128}$/.test(candidate))
    throw new InstallerError("stream_id_required","A valid Basin stream ID is required to finish installation.");
  shell.wrangler(["basin","pipelines","streams","get",candidate]);
  return {streamId:candidate,basinMode:"wrangler_setup"};
}
export function ensureQueues({shell,names,manifest}){
  if(manifest.resources.queuesReady)return {queuesReady:true};
  const listed=shell.wrangler(["queues","list"],{allowFailure:true});
  if(!listed.ok)throw new InstallerError("queue_list_failed",
    "Cannot inspect Queues. Verify Workers Paid and account permissions.");
  const existing=new Set(listed.stdout.split(/\r?\n/).flatMap(line=>
    line.trim().split(/\s+/).filter(word=>word===names.queue||word===names.dlq)));
  for(const [name,field] of [[names.queue,"queueName"],[names.dlq,"dlqName"]]){
    const recorded=manifest.resources[field];
    if(recorded&&recorded!==name)throw new InstallerError("queue_identity_mismatch");
    if(existing.has(name)){
      if(!recorded)throw new InstallerError("unowned_queue",
        "Named Queue already exists; recover its install manifest.");
    }else{
      if(recorded)throw new InstallerError("missing_queue","Previously installed Queue was removed.");
      shell.wrangler(["queues","create",name]);
      manifest.mark(field,{[field]:name});
    }
  }
  return {queuesReady:true};
}

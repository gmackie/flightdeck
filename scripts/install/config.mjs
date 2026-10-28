/**
 * Generated Wrangler configs. Each Worker lives entirely in the installer's
 * account. Console assets must always run through Access verification.
 */
import {guardedConfig} from "./engine.mjs";
export function buildConfigs({accountId,names,d1Id,streamId,adminEmails,access,
  enableJourneys=true,enableAI=false,enableMcp=true,queryUnits=50000}){
  const base={
    "$schema":"../../node_modules/wrangler/config-schema.json",
    account_id:accountId,
    compatibility_date:"2026-10-27",
    observability:{enabled:true},
    preview_urls:false,
  };
  const d1={binding:"META",database_name:names.database,database_id:d1Id,
    migrations_dir:"../../migrations"};
  const core={
    ...base,name:names.core,main:"src/index.ts",workers_dev:false,
    vars:{SINK_MODE:"basin",SOURCE_REGISTRY_MODE:"d1"},
    pipelines:[{binding:"STREAM",stream:streamId}],
    d1_databases:[d1],
    ...(enableJourneys?{
      queues:{producers:[{binding:"JOURNEY_QUEUE",queue:names.queue}]}
    }:{}),
  };
  const journey=enableJourneys?{
    ...base,name:names.journey,main:"src/index.ts",workers_dev:false,
    d1_databases:[d1],
    durable_objects:{bindings:[{name:"JOURNEYS",class_name:"JourneyInstance"}]},
    migrations:[{tag:"v1",new_sqlite_classes:["JourneyInstance"]}],
    queues:{consumers:[{
      queue:names.queue,max_batch_size:10,max_batch_timeout:5,
      max_retries:5,dead_letter_queue:names.dlq
    }]},
  }:null;
  const consoleConfig={
    ...base,name:names.console,main:"src/index.ts",workers_dev:true,
    assets:{
      directory:"./dist",binding:"ASSETS",
      not_found_handling:"single-page-application",
      run_worker_first:true
    },
    d1_databases:[d1],
    services:[
      {binding:"CORE",service:names.core},
      ...(enableJourneys?[{binding:"JOURNEY_SERVICE",service:names.journey}]:[])
    ],
    vars:{
      ACCESS_TEAM_DOMAIN:access?.teamDomain??"locked.invalid",
      ACCESS_AUD:access?.aud??"locked",
      ACCOUNT_ID:accountId,
      BASIN_BUCKET:names.bucket,
      BASIN_TABLE:"default."+names.table,
      PROJECT_ID:"default",
      ADMIN_EMAILS:adminEmails.join(","),
      QUERY_QUOTA_REQUIRED:"true",
      QUERY_MONTHLY_UNITS:String(queryUnits),
      AI_ENABLED:enableAI?"true":"false",
      AI_MODEL:"@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      AI_INVESTIGATION_DAILY_LIMIT:"3",
      GITHUB_REPOSITORY:"",
    },
    ...(enableAI?{ai:{binding:"AI"}}:{})
  };
  const mcp=enableMcp?{
    ...base,name:names.mcp,main:"src/index.ts",workers_dev:true,
    compatibility_flags:["nodejs_compat"],
    services:[{binding:"CONSOLE",service:names.console}],
    vars:{
      ACCESS_TEAM_DOMAIN:access?.teamDomain??"locked.invalid",
      ACCESS_AUD:access?.aud??"locked",
      ADMIN_EMAILS:adminEmails.join(","),
      CONSOLE_ORIGIN:"https://"+names.console+".invalid",
    },
  }:null;
  return {core,journey,console:consoleConfig,mcp};
}
export function writeConfigs(configs){
  const paths={
    core:"apps/core/wrangler.generated.jsonc",
    console:"apps/console/wrangler.generated.jsonc",
    journey:"apps/journey/wrangler.generated.jsonc",
    mcp:"apps/mcp/wrangler.generated.jsonc"
  };
  for(const [name,data] of Object.entries(configs)){
    if(data)guardedConfig(paths[name],data);
  }
  return paths;
}
export function assertLocked(configs) {
  if(configs.console.assets.run_worker_first!==true)
    throw new Error("Refusing unsafe console asset routing");
  if(configs.core.workers_dev!==false)
    throw new Error("Refusing public core RPC route");
  if(configs.console.vars.ACCESS_TEAM_DOMAIN!=="locked.invalid"||
    configs.console.vars.ACCESS_AUD!=="locked")
    throw new Error("First deploy must be locked");
  if(configs.mcp&&(configs.mcp.vars.ACCESS_TEAM_DOMAIN!=="locked.invalid"||
    configs.mcp.vars.ACCESS_AUD!=="locked"))
    throw new Error("First MCP deploy must be locked");
}
export function assertReady(configs,access) {
  if(!access?.aud||!access?.teamDomain||
     access.teamDomain==="locked.invalid")throw new Error("Access not ready");
  if(configs.console.assets.run_worker_first!==true||
     configs.console.vars.ACCESS_AUD!==access.aud)
    throw new Error("Console is not fully Access protected");
  if(configs.mcp&&configs.mcp.vars.ACCESS_AUD!==access.aud)
    throw new Error("MCP and console Access AUD must match");
}

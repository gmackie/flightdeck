#!/usr/bin/env node
/**
 * Account-owned installer for Flightdeck Core.
 * Runs wrangler in the user's authenticated CLI session; no Flightdeck API keys leave the machine.
 * Basin pipeline setup is interactive until a stable declarative API is supported end-to-end.
 */
import {randomBytes,createHash} from "node:crypto";
import {existsSync,mkdirSync,readFileSync,writeFileSync,chmodSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {parseArgs} from "node:util";
import {createInterface} from "node:readline/promises";
import process from "node:process";

const argv=process.argv.slice(2).filter(x=>x!=="--");
const {values}=parseArgs({args:argv,options:{
  name:{type:"string"},bucket:{type:"string"},mode:{type:"string"},
  "stream-id":{type:"string"},"source-id":{type:"string"},"project-id":{type:"string"},
  "dry-run":{type:"boolean",default:false},yes:{type:"boolean",default:false},
  "skip-deploy":{type:"boolean",default:false},help:{type:"boolean",default:false},
}});
if(values.help){
  console.log("Usage: pnpm setup -- [--mode basin|r2] [--name NAME] [--bucket NAME] [--stream-id ID] [--source-id ID] [--project-id ID] [--yes] [--dry-run] [--skip-deploy]");
  process.exit(0);
}
const rl=createInterface({input:process.stdin,output:process.stdout});
const choose=async(q,defaultValue)=>values.yes?defaultValue:(await rl.question(`${q} [${defaultValue}]: `)).trim()||defaultValue;
const safeName=v=>/^[a-z][a-z0-9-]{2,55}$/.test(v);
const safeId=v=>/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const base=".flightdeck", manifestFile=`${base}/deploy.json`, sourceFile=`${base}/sources.json`, tokenFile=`${base}/source-tokens.json`;
mkdirSync(base,{recursive:true,mode:0o700});
const load=(path,fallback)=>existsSync(path)?JSON.parse(readFileSync(path,"utf8")):fallback;
const prior=load(manifestFile,{});
const name=values.name??await choose("Core Worker name",prior.name??"flightdeck-core");
const bucket=values.bucket??await choose("R2 bucket",prior.bucket??"flightdeck-events");
const mode=values.mode??await choose("Durable sink mode (basin or r2)",prior.mode??"basin");
const sourceId=values["source-id"]??await choose("First application source ID","default-app");
const projectId=values["project-id"]??await choose("Project ID","default");
if(!safeName(name)||!safeName(bucket)||!safeId(sourceId)||!safeId(projectId)||!["basin","r2"].includes(mode))
  throw new Error("Invalid Worker, bucket, mode, source or project ID");
if(prior.name && (prior.name!==name||prior.bucket!==bucket||prior.mode!==mode))
  throw new Error("Existing deployment differs; migration is required. Do not overwrite resources.");
const streamId=mode==="basin"?(values["stream-id"]??prior.streamId??""):undefined;
const run=(args,stdin)=>{
  const command=`pnpm exec wrangler ${args.join(" ")}`;
  if(values["dry-run"]){console.log("[dry-run]",command);return;}
  const result=spawnSync("pnpm",["exec","wrangler",...args],{
    stdio:stdin===undefined?"inherit":["pipe","inherit","inherit"],input:stdin,encoding:"utf8",
    env:process.env,
  });
  if(result.error)throw result.error;
  if(result.status!==0)throw new Error(`Failed: ${command} (exit ${result.status})`);
};
const config={
  $schema:"../../node_modules/wrangler/config-schema.json",
  name,main:"src/index.ts",compatibility_date:"2026-10-27",workers_dev:false,
  vars:{SINK_MODE:mode},observability:{enabled:true},
  ...(mode==="basin"
    ?{pipelines:[{binding:"STREAM",stream:streamId||"STREAM_ID_REQUIRED"}]}
    :{r2_buckets:[{binding:"EVENTS",bucket_name:bucket}]}),
};
const configFile="apps/core/wrangler.generated.jsonc";
if(mode==="basin"&&!streamId) {
  console.log("\nBasin needs a configured stream. Create the catalog and pipeline interactively:");
  console.log(`  pnpm exec wrangler r2 bucket create ${bucket}`);
  console.log(`  pnpm exec wrangler basin catalog enable ${bucket}`);
  console.log("  pnpm exec wrangler basin pipelines setup");
  console.log("Use basin/events.schema.json, a Catalog Table sink, and save its STREAM ID.");
  console.log("Then rerun setup with --stream-id YOUR_STREAM_ID.");
  if(!values["dry-run"]&&!values["skip-deploy"]){
    const answer=await choose("Create bucket and catalog now? (yes/no)","no");
    if(answer==="yes"){
      if(!prior.bucketCreated)run(["r2","bucket","create",bucket]);
      if(!prior.catalogEnabled)run(["basin","catalog","enable",bucket]);
      console.log("Next: run 'pnpm exec wrangler basin pipelines setup' and rerun setup with --stream-id.");
    }
  }
  rl.close();
  process.exit(0);
}
const sources=load(sourceFile,{});
const tokens=load(tokenFile,{});
if(!sources[sourceId]){
  const token=randomBytes(32).toString("base64url");
  sources[sourceId]={
    sha256:createHash("sha256").update(token).digest("hex"),projectId,
    allowedEvents:["page.viewed","project.opened","project.created","feature.exposed","identity.identified","rum.*"],
    allowedProperties:{
      "page.viewed":["route"],"project.opened":["template"],"project.created":["template"],
      "feature.exposed":["flagKey","variant"],"identity.identified":[],
      "rum.*":["value","rating","metricId"]
    },
  };
  tokens[sourceId]=token;
}else if(sources[sourceId].projectId!==projectId)throw new Error("Source already belongs to another project");
if(!values["dry-run"]){
  writeFileSync(configFile,JSON.stringify(config,null,2)+"\n");
  writeFileSync(sourceFile,JSON.stringify(sources,null,2)+"\n",{mode:0o600});
  writeFileSync(tokenFile,JSON.stringify(tokens,null,2)+"\n",{mode:0o600});
  chmodSync(sourceFile,0o600);chmodSync(tokenFile,0o600);
  writeFileSync(manifestFile,JSON.stringify({name,bucket,mode,streamId,createdAt:prior.createdAt??new Date().toISOString()},null,2)+"\n",{mode:0o600});
}
console.log("\nDeployment:");
console.log(`  Name: ${name}\n  Sink: ${mode}\n  Source: ${sourceId}\n  Project: ${projectId}`);
if(!values["skip-deploy"]){
  if(!values.yes&&!values["dry-run"]){
    const response=await rl.question("Provision and deploy now? [yes/NO]: ");
    if(response.trim().toLowerCase()!=="yes"){console.log("Cancelled before resource mutation.");rl.close();process.exit(0);}
  }
  if(mode==="r2"&&!prior.createdAt)run(["r2","bucket","create",bucket]);
  run(["deploy","--config",configFile]);
  run(["secret","put","SOURCE_CREDENTIALS","--config",configFile],JSON.stringify(sources)+"\n");
}
if(!values["dry-run"]){
  console.log("\nOne-time source credential (keep server-side, never in browser):");
  console.log(`  FLIGHTDECK_SOURCE_ID=${sourceId}`);
  console.log(`  FLIGHTDECK_SOURCE_TOKEN=${tokens[sourceId]}`);
  console.log("These values are also stored locally in .flightdeck/source-tokens.json (mode 0600).");
}
console.log("\nAdd a service binding to your own Worker: {binding:'FLIGHTDECK',service:'"+name+"'}");
rl.close();

#!/usr/bin/env node
/**
 * Account-owned Flightdeck deployment plan and optional explicit application.
 * Does not create public collection endpoints and NEVER stores SQL tokens on disk.
 * Resources must already exist: Basin stream, R2 Catalog, D1 database, Access.
 */
import {readFileSync,writeFileSync,existsSync,chmodSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {parseArgs} from "node:util";
import {createInterface} from "node:readline/promises";
import process from "node:process";

const {values}=parseArgs({args:process.argv.slice(2).filter(x=>x!=="--"),options:{
  "d1-id":{type:"string"},"d1-name":{type:"string"},
  "stream-id":{type:"string"},bucket:{type:"string"},
  "account-id":{type:"string"},host:{type:"string"},
  "access-domain":{type:"string"},"access-aud":{type:"string"},
  "admin-email":{type:"string"},"project-id":{type:"string"},
  "source-id":{type:"string"},name:{type:"string"},
  "query-units":{type:"string"},"ai-daily-limit":{type:"string"},
  apply:{type:"boolean",default:false},yes:{type:"boolean",default:false},
  "dry-run":{type:"boolean",default:false},help:{type:"boolean",default:false}
}});
if(values.help){
 console.log("Usage: pnpm workspace:deploy -- --d1-id UUID --stream-id ID --account-id ID --host analytics.example.com --access-domain team.cloudflareaccess.com --access-aud AUD --admin-email owner@example.com [--apply --yes]");
 process.exit(0);
}
const required=["d1-id","stream-id","account-id","host","access-domain","access-aud","admin-email"];
const missing=required.filter(x=>!values[x]);
if(missing.length)throw new Error("Missing required deployment flags: "+missing.join(", "));
const d1Id=values["d1-id"],d1Name=values["d1-name"]??"flightdeck-meta";
if(!/^[a-z0-9-]{3,63}$/.test(d1Name))throw new Error("Invalid D1 database name");
const streamId=values["stream-id"],bucket=values.bucket??"flightdeck-events";
const project=values["project-id"]??"default",sourceId=values["source-id"]??"default-app";
const accountId=values["account-id"],host=values.host;
const adminEmail=values["admin-email"];
const queryUnits=Number(values["query-units"]??"50000");
const aiDaily=Number(values["ai-daily-limit"]??"3");
if(!/^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i.test(d1Id)||
   !/^[A-Za-z0-9_-]{4,128}$/.test(streamId)||
   !/^[a-f0-9]{32}$/i.test(accountId)||
   !/^[a-z0-9-]{3,63}$/.test(bucket)||!/^[-a-z0-9]+\.cloudflareaccess\.com$/.test(values["access-domain"])||
   !/^[A-Za-z0-9_-]{20,256}$/.test(values["access-aud"])||
   !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(project)||
   !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(sourceId)||
   !/^[a-z0-9.-]+$/.test(host)||!host.includes(".")||
   !/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(adminEmail)||
   !Number.isSafeInteger(queryUnits)||queryUnits<0||queryUnits>100_000_000||
   !Number.isSafeInteger(aiDaily)||aiDaily<0||aiDaily>100)
 throw new Error("Invalid argument; check UUID/stream/account/domain/limits");
const root=".flightdeck/deploy.json",corePath="apps/core/wrangler.generated.jsonc",consolePath="apps/console/wrangler.generated.jsonc";
const entry=values.name??"flightdeck-core",consoleName="flightdeck-console";
if(!/^[a-z][a-z0-9-]{2,55}$/.test(entry))throw new Error("Invalid private Worker name");
const d1={binding:"META",database_name:d1Name,database_id:d1Id,migrations_dir:"../../migrations"};
const plan=[
  "Prepare local config for Core and Console with the same D1 metadata database",
  "Verify Cloudflare account and Basin stream selection",
  "Export D1 backup before applying schema migrations",
  "Apply D1 migrations in remote account",
  "Seed default project and source metadata",
  "Deploy the Core Worker with workers_dev=false",
  "Install server-side source registry secret",
  "Build and deploy the Access-protected console",
  "Install Basin SQL token as a Worker secret",
  "Perform anonymous-access smoke test and verify SQL/query service"
];
console.log("\nFlightdeck account-owned deployment plan:");
console.log(JSON.stringify({accountId,core:entry,console:consoleName,host,d1Id,d1Name,streamId,bucket,project,adminEmail,queryUnits,aiDaily,steps:plan},null,2));
if(values["dry-run"]){console.log("\nDry-run complete: no files or remote resources changed.");process.exit(0);}
const spawn=(args,input)=>{
 const command=["exec","wrangler",...args];
 const r=spawnSync("pnpm",command,{encoding:"utf8",
  stdio:input===undefined?"inherit":["pipe","inherit","inherit"],input,env:process.env
 });
 if(r.error)throw r.error;
 if(r.status!==0)throw new Error("Wrangler command failed: "+args[0]+" "+args[1]+" (exit "+r.status+")");
};
const runNode=args=>{
 const r=spawnSync(process.execPath,args,{stdio:"inherit",env:process.env});
 if(r.error)throw r.error;
 if(r.status!==0)throw new Error("Flightdeck setup failed at "+args[0]);
};
if(existsSync(root)){
 const previous=JSON.parse(readFileSync(root,"utf8"));
 if(previous.streamId!==undefined&&previous.streamId!==streamId)
   throw new Error("Refusing to swap an existing Basin stream silently.");
 if(previous.bucket!==undefined&&previous.bucket!==bucket)
   throw new Error("Refusing to swap an existing R2 catalog silently.");
}
runNode(["scripts/setup.mjs","--yes","--skip-deploy","--mode","basin","--name",entry,
  "--stream-id",streamId,"--bucket",bucket,"--project-id",project,"--source-id",sourceId]);
runNode(["scripts/setup-console.mjs","--yes","--skip-deploy","--host",host,
  "--access-domain",values["access-domain"],"--access-aud",values["access-aud"],
  "--account-id",accountId,"--bucket",bucket,"--project-id",project]);
const core=JSON.parse(readFileSync(corePath,"utf8"));
const consoleConfig=JSON.parse(readFileSync(consolePath,"utf8"));
core.d1_databases=[d1];
consoleConfig.d1_databases=[d1];
consoleConfig.vars={...consoleConfig.vars,
  ADMIN_EMAILS:adminEmail,QUERY_QUOTA_REQUIRED:"true",
  QUERY_MONTHLY_UNITS:String(queryUnits),AI_INVESTIGATION_DAILY_LIMIT:String(aiDaily),
  AI_ENABLED:"false"
};
writeFileSync(corePath,JSON.stringify(core,null,2)+"\n",{mode:0o600});
writeFileSync(consolePath,JSON.stringify(consoleConfig,null,2)+"\n",{mode:0o600});
chmodSync(corePath,0o600);chmodSync(consolePath,0o600);
const manifest=JSON.parse(readFileSync(root,"utf8"));
if(manifest.d1Id&&manifest.d1Id!==d1Id)throw new Error("Refusing to swap existing D1 metadata database");
manifest.d1Id=d1Id;manifest.d1Name=d1Name;manifest.accountId=accountId;
manifest.consoleHost=host;manifest.adminEmail=adminEmail;
writeFileSync(root,JSON.stringify(manifest,null,2)+"\n",{mode:0o600});
chmodSync(root,0o600);
if(!values.apply){
 console.log("\nGenerated account-specific Core and Console configs. To deploy, rerun with --apply --yes.");
 process.exit(0);
}
if(!values.yes){
 const rl=createInterface({input:process.stdin,output:process.stdout});
 const answer=await rl.question("Perform remote D1 migration and Worker deploy? Type DEPLOY to continue: ");
 rl.close();
 if(answer!=="DEPLOY"){console.log("Cancelled without remote mutations.");process.exit(0);}
}
if(!process.env.FLIGHTDECK_BASIN_SQL_TOKEN||process.env.FLIGHTDECK_BASIN_SQL_TOKEN.length<20)
 throw new Error("FLIGHTDECK_BASIN_SQL_TOKEN env secret required to apply. Not stored in files.");
const backupDir=".flightdeck/backups";
const {mkdirSync}=await import("node:fs");
mkdirSync(backupDir,{recursive:true,mode:0o700});
const backupPath=backupDir+"/metadata-"+new Date().toISOString().replaceAll(":","-")+".sql";
console.log("Backing up remote metadata D1 to "+backupPath);
spawn(["d1","export",d1Name,"--remote","--output",backupPath,"--config",consolePath]);
spawn(["d1","migrations","apply",d1Name,"--remote","--config",consolePath]);
const sql="INSERT OR IGNORE INTO projects(id,name) VALUES('"+project+"','"+project+"');"+
  "INSERT OR IGNORE INTO sources(id,project_id,display_name,enabled) VALUES('"+sourceId+"','"+project+"','"+sourceId+"',1);";
spawn(["d1","execute",d1Name,"--remote","--command",sql,"--config",consolePath,"--yes"]);
spawn(["deploy","--config",corePath]);
spawn(["secret","put","SOURCE_CREDENTIALS","--config",corePath],
  readFileSync(".flightdeck/sources.json","utf8"));
console.log("Core deployed with source registry secret.");
spawn(["deploy","--config",consolePath]);
spawn(["secret","put","BASIN_SQL_TOKEN","--config",consolePath],
  process.env.FLIGHTDECK_BASIN_SQL_TOKEN+"\n");
console.log("Deployment commands finished. Run remote doctor and validate Basin query responses before accepting traffic.");

#!/usr/bin/env node
/**
 * Restore a D1 SQL export into a DIFFERENT, empty D1 database.
 * Never silently overwrite the live Flightdeck metadata database.
 */
import {readFileSync,existsSync,writeFileSync,mkdirSync,unlinkSync} from "node:fs";
import {resolve,dirname,basename} from "node:path";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {parseArgs} from "node:util";
const {values}=parseArgs({args:process.argv.slice(2).filter(x=>x!=="--"),options:{
  file:{type:"string"},"target-d1-id":{type:"string"},"target-d1-name":{type:"string"},
  apply:{type:"boolean",default:false},help:{type:"boolean",default:false},
}});
if(values.help){
 console.log("Usage: pnpm workspace:restore -- --file .flightdeck/backups/metadata-....sql --target-d1-id UUID --target-d1-name NAME [--apply]");
 process.exit(0);
}
const file=resolve(values.file??"");
if(!values.file||!file.startsWith(resolve(".flightdeck/backups")+"/")||
   !file.endsWith(".sql")||!existsSync(file)||
   !existsSync(file+".manifest.json"))throw new Error("Signed-off backup SQL + metadata manifest required");
const manifest=JSON.parse(readFileSync(".flightdeck/deploy.json","utf8"));
const backup=JSON.parse(readFileSync(file+".manifest.json","utf8"));
const digest=createHash("sha256").update(readFileSync(file)).digest("hex");
if(digest!==backup.sha256)throw new Error("Backup checksum does not match manifest");
const targetId=values["target-d1-id"],targetName=values["target-d1-name"];
if(!targetId||!targetName||! /^[0-9a-f-]{36}$/i.test(targetId)||
   !/^[a-z0-9-]{3,63}$/.test(targetName))throw new Error("Explicit new D1 target required");
if(targetId===manifest.d1Id||targetName===manifest.d1Name)
  throw new Error("Refusing to restore over the active production database");
const configPath=".flightdeck/restore-target.wrangler.jsonc";
const config={name:"flightdeck-restore-temp",main:"apps/core/src/index.ts",
  compatibility_date:"2026-10-27",workers_dev:false,
  d1_databases:[{binding:"META",database_name:targetName,database_id:targetId}]};
console.log(JSON.stringify({file,source:backup.d1Name,restoreTarget:targetName,
  restoreTargetId:targetId,digest,warning:"Must be a fresh, empty D1 database. Existing data may conflict."},null,2));
if(!values.apply){console.log("Dry-run: no Cloudflare mutations performed.");process.exit(0);}
writeFileSync(configPath,JSON.stringify(config,null,2)+"\n",{mode:0o600});
try{
 const args=["exec","wrangler","d1","execute",targetName,"--remote","--file",file,
   "--config",configPath,"--yes"];
 const r=spawnSync("pnpm",args,{stdio:"inherit",env:process.env});
 if(r.error)throw r.error;
 if(r.status!==0)throw new Error("Restore failed; inspect target database before retry");
 console.log("D1 SQL import succeeded. Verify schema/data and explicitly switch application bindings in a separate operation.");
}finally{unlinkSync(configPath);}

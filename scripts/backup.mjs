#!/usr/bin/env node
import {readFileSync,existsSync,mkdirSync,writeFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {parseArgs} from "node:util";
const {values}=parseArgs({args:process.argv.slice(2).filter(x=>x!=="--"),options:{
  "dry-run":{type:"boolean",default:false},apply:{type:"boolean",default:false},help:{type:"boolean",default:false}
}});
if(values.help){
 console.log("Usage: pnpm workspace:backup -- [--dry-run] --apply");
 process.exit(0);
}
const manifest=".flightdeck/deploy.json";
if(!existsSync(manifest))throw new Error("Deployment manifest missing; run setup first");
const m=JSON.parse(readFileSync(manifest,"utf8"));
if(!m.d1Name||!m.d1Id)throw new Error("D1 metadata database not configured");
const dir=".flightdeck/backups";
const output=dir+"/metadata-"+new Date().toISOString().replaceAll(":","-")+".sql";
console.log("Metadata backup plan: "+m.d1Name+" to "+output);
console.log("This is a D1 export only; it does NOT back up Basin/Iceberg event history.");
if(!values.apply||values["dry-run"]){console.log("No remote operations performed.");process.exit(0);}
mkdirSync(dir,{recursive:true,mode:0o700});
const args=["exec","wrangler","d1","export",m.d1Name,"--remote","--output",output,
  "--config","apps/console/wrangler.generated.jsonc"];
const result=spawnSync("pnpm",args,{stdio:"inherit",env:process.env});
if(result.error)throw result.error;
if(result.status!==0)throw new Error("Remote D1 export failed");
const sha=createHash("sha256").update(readFileSync(output)).digest("hex");
const metadata={filename:output,sha256:sha,d1Name:m.d1Name,d1Id:m.d1Id,
  accountId:m.accountId,createdAt:new Date().toISOString(),
  scope:"D1 metadata only; not an R2/Iceberg data backup"};
writeFileSync(output+".manifest.json",JSON.stringify(metadata,null,2)+"\n",{mode:0o600});
console.log("Metadata export written and SHA-256 verified: "+sha);

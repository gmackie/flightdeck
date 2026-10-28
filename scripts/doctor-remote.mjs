#!/usr/bin/env node
/**
 * Read-only remote health checks. Does not use or reveal API secrets.
 * Does NOT prove Basin SQL correctness or private-worker authorization.
 */
import {readFileSync,existsSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {parseArgs} from "node:util";
const {values}=parseArgs({args:process.argv.slice(2).filter(x=>x!=="--"),options:{
  "dry-run":{type:"boolean",default:false},help:{type:"boolean",default:false}
}});
if(values.help){console.log("Usage: pnpm workspace:doctor -- [--dry-run]");process.exit(0);}
const manifest=".flightdeck/deploy.json";
if(!existsSync(manifest))throw new Error("No deployment manifest");
const m=JSON.parse(readFileSync(manifest,"utf8"));
if(!m.d1Name||!m.consoleHost)throw new Error("Incomplete account-owned install manifest");
const commands=[
 ["d1","info",m.d1Name,"--json","--config","apps/console/wrangler.generated.jsonc"],
 ["d1","migrations","list",m.d1Name,"--remote","--config","apps/console/wrangler.generated.jsonc"],
];
for(const args of commands){
 if(values["dry-run"]){console.log("[dry-run] pnpm exec wrangler "+args.join(" "));continue;}
 const r=spawnSync("pnpm",["exec","wrangler",...args],{stdio:"inherit",env:process.env});
 if(r.error)throw r.error;
 if(r.status!==0)process.exitCode=1;
}
if(values["dry-run"])process.exit(0);
const url="https://"+m.consoleHost+"/api/config";
try{
 const response=await fetch(url,{redirect:"manual",signal:AbortSignal.timeout(10_000)});
 console.log("Anonymous console response:",response.status);
 if(response.status===200){
   console.error("SECURITY FAILURE: console API is accessible without authentication");
   process.exitCode=1;
 }else if(![301,302,303,307,308,401,403,404,503].includes(response.status)){
   console.warn("Unexpected anonymous HTTP status. Review Access and Worker JWT enforcement.");
   process.exitCode=1;
 }
}catch(e){console.error("Remote console probe failed",String(e));process.exitCode=1;}
console.log("This doctor validates D1 visibility and anonymous access only. Validate Basin pipelines and authenticated queries separately.");

#!/usr/bin/env node
import {existsSync,readFileSync} from "node:fs";
const checks=[
  ["deployment manifest",".flightdeck/deploy.json"],
  ["generated Worker configuration","apps/core/wrangler.generated.jsonc"],
  ["source policy registry",".flightdeck/sources.json"],
  ["source credential recovery",".flightdeck/source-tokens.json"],
];
let errors=0;
for(const [label,path] of checks){
  if(!existsSync(path)){console.error("MISSING",label,path);errors++;continue;}
  try{JSON.parse(readFileSync(path,"utf8"));console.log("OK",label);}
  catch{console.error("INVALID JSON",label);errors++;}
}
if(!errors){
  const manifest=JSON.parse(readFileSync(".flightdeck/deploy.json","utf8"));
  console.log("Core:",manifest.name,"Mode:",manifest.mode);
  if(manifest.mode!=="basin")console.warn("WARN: R2 direct storage is a small-scale fallback, not queryable Iceberg.");
  console.log("This is a local configuration check only. It does NOT verify Access, pipeline health, credential rotation or billing.");
}
process.exitCode=errors?1:0;

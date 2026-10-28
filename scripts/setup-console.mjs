#!/usr/bin/env node
/**
 * Fail-closed console deployment into the installer's Cloudflare account.
 * Cloudflare Access application and Basin SQL token must be configured by the owner.
 */
import {existsSync,mkdirSync,readFileSync,writeFileSync,chmodSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {parseArgs} from "node:util";
import {createInterface} from "node:readline/promises";
import process from "node:process";

const argv=process.argv.slice(2).filter(x=>x!=="--");
const {values}=parseArgs({args:argv,options:{
  host:{type:"string"},name:{type:"string"},"access-domain":{type:"string"},
  "access-aud":{type:"string"},"account-id":{type:"string"},
  bucket:{type:"string"},"project-id":{type:"string"},table:{type:"string"},
  yes:{type:"boolean",default:false},"dry-run":{type:"boolean",default:false},
  "skip-deploy":{type:"boolean",default:false},help:{type:"boolean",default:false},
}});
if(values.help){
 console.log("Usage: pnpm setup:console -- --host dashboard.example.com --access-domain team.cloudflareaccess.com --access-aud AUD --account-id ID [--bucket BUCKET] [--project-id PROJECT] [--yes] [--dry-run]");
 process.exit(0);
}
const rl=createInterface({input:process.stdin,output:process.stdout});
const ask=async(label,defaultValue="")=>values.yes?defaultValue:(await rl.question(`${label}${defaultValue?` [${defaultValue}]`:""}: `)).trim()||defaultValue;
const root=".flightdeck", coreFile=`${root}/deploy.json`, outputFile="apps/console/wrangler.generated.jsonc";
const prior=existsSync(coreFile)?JSON.parse(readFileSync(coreFile,"utf8")):{};
const host=values.host??await ask("Console hostname (must have a matching Cloudflare Access application)");
const name=values.name??await ask("Worker name","flightdeck-console");
const accessDomain=values["access-domain"]??await ask("Access team domain (e.g. team.cloudflareaccess.com)");
const accessAud=values["access-aud"]??await ask("Cloudflare Access application AUD");
const accountId=values["account-id"]??await ask("Cloudflare account ID");
const bucket=values.bucket??await ask("Basin Catalog R2 bucket",prior.bucket??"flightdeck-events");
const projectId=values["project-id"]??await ask("Project ID","default");
const table=values.table??await ask("Basin SQL table","default.flightdeck_events");
if(!/^[a-z][a-z0-9-]{2,55}$/.test(name) || !/^[A-Za-z0-9.-]+$/.test(host) ||
 !host.includes(".") || !/^[-a-z0-9]+\.cloudflareaccess\.com$/.test(accessDomain) ||
 !/^[a-z0-9]{32}$/i.test(accountId) || !/^[a-z0-9-]{3,63}$/.test(bucket) ||
 !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(projectId) ||
 !/^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(table) ||
 !/^[A-Za-z0-9_-]{20,256}$/.test(accessAud))throw new Error("Invalid console deployment configuration");
const configuration={
  $schema:"../../node_modules/wrangler/config-schema.json",
  name,main:"src/index.ts",compatibility_date:"2026-10-27",
  workers_dev:false,preview_urls:false,
  routes:[{pattern:host,custom_domain:true}],
  assets:{directory:"./dist",binding:"ASSETS",not_found_handling:"single-page-application"},
  ai:{binding:"AI"},
  vars:{ACCESS_TEAM_DOMAIN:accessDomain,ACCESS_AUD:accessAud,ACCOUNT_ID:accountId,BASIN_BUCKET:bucket,
    BASIN_TABLE:table,PROJECT_ID:projectId,AI_ENABLED:"false",
    AI_MODEL:"@cf/meta/llama-3.3-70b-instruct-fp8-fast"},
  observability:{enabled:true},
};
console.log("\nConsole: https://"+host+" (Access required on EVERY request)\nAccount: "+accountId+"\nBasin: "+bucket+"/"+table);
if(!values["dry-run"]){
 mkdirSync(root,{recursive:true,mode:0o700});
 writeFileSync(outputFile,JSON.stringify(configuration,null,2)+"\n",{mode:0o600});
 chmodSync(outputFile,0o600);
}
if(!values["skip-deploy"]){
 if(!values.yes&&!values["dry-run"]){
   const response=await rl.question("Deploy the console to this account? [yes/NO]: ");
   if(response.trim().toLowerCase()!=="yes"){console.log("Cancelled.");rl.close();process.exit(0);}
 }
 const command=(args)=>{
  if(values["dry-run"]){console.log("[dry-run] pnpm exec wrangler "+args.join(" "));return;}
  const result=spawnSync("pnpm",["exec","wrangler",...args],{stdio:"inherit",env:process.env});
  if(result.error)throw result.error;
  if(result.status!==0)throw new Error("Wrangler failed with exit "+result.status);
 };
 command(["deploy","--config",outputFile]);
 console.log("\nConfigure a restricted Basin SQL API secret:");
 console.log("pnpm exec wrangler secret put BASIN_SQL_TOKEN --config "+outputFile);
}
console.log("\nIMPORTANT: Define a Cloudflare Access self-hosted application for https://"+host);
console.log("Verify anonymous requests are denied. The Worker also verifies the Access JWT and fails closed if misconfigured.");
console.log("The console has no public demo mode. AI is disabled by default.");
rl.close();

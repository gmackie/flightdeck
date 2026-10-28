#!/usr/bin/env node
/**
 * Flightdeck first-account setup wizard. Provider operations use the operator's
 * local authenticated Wrangler session. Never proxies Cloudflare credentials
 * through Flightdeck or ChatGPT. Safe to resume after provider-side steps.
 */
import {spawnSync} from "node:child_process";
import {existsSync,mkdirSync,readFileSync,writeFileSync,chmodSync} from "node:fs";
import {createInterface} from "node:readline/promises";
import {parseArgs} from "node:util";
import process from "node:process";

const args=process.argv.slice(2).filter(x=>x!=="--");
const {values}=parseArgs({args,options:{
  "dry-run":{type:"boolean",default:false},
  "yes":{type:"boolean",default:false},
  "resume":{type:"boolean",default:false},
  "account-id":{type:"string"},"name":{type:"string"},
  "d1-name":{type:"string"},"d1-id":{type:"string"},
  "bucket":{type:"string"},"stream-id":{type:"string"},
  "host":{type:"string"},"access-domain":{type:"string"},
  "access-aud":{type:"string"},"admin-email":{type:"string"},
  "auto-access":{type:"boolean",default:false},
  "bootstrap-zero-trust":{type:"boolean",default:false},
  "help":{type:"boolean",default:false}
}});
if(values.help){
 console.log("Usage: pnpm wizard -- [--dry-run] [--yes --account-id ID --d1-id UUID --stream-id ID --host DOMAIN --access-domain TEAM.cloudflareaccess.com --access-aud AUD --admin-email EMAIL]");
 process.exit(0);
}
const statePath=".flightdeck/wizard.json";
const previous=values.resume&&existsSync(statePath)?
  JSON.parse(readFileSync(statePath,"utf8")):{};
const isTTY=Boolean(process.stdin.isTTY)&&!values.yes;
const rl=isTTY?createInterface({input:process.stdin,output:process.stdout}):null;
const ask=async(label,fallback="")=>{
  if(!rl)return fallback;
  return (await rl.question(label+(fallback?" ["+fallback+"]":"")+": ")).trim()||fallback;
};
const choose=async(label,options,defaultIndex=0)=>{
  if(!rl)return options[defaultIndex];
  options.forEach((v,i)=>console.log("  "+(i+1)+". "+v));
  for(;;){
    const index=Number(await ask(label,String(defaultIndex+1)))-1;
    if(index>=0&&index<options.length)return options[index];
  }
};
const requireString=(value,label,pattern)=>{
  if(typeof value!=="string"||!pattern.test(value))
    throw new Error(label+" is invalid or missing");
  return value;
};
let accountId=values["account-id"]??previous.accountId??process.env.CLOUDFLARE_ACCOUNT_ID??"";
const name=values.name??previous.name??"flightdeck-core";
const bucket=values.bucket??previous.bucket??"flightdeck-events";
const d1Name=values["d1-name"]??previous.d1Name??"flightdeck-meta";
let d1Id=values["d1-id"]??previous.d1Id??"";
let streamId=values["stream-id"]??previous.streamId??"";
let host=values.host??previous.host??"";
let accessDomain=values["access-domain"]??previous.accessDomain??"";
let accessAud=values["access-aud"]??previous.accessAud??"";
let adminEmail=values["admin-email"]??previous.adminEmail??"";
const id=/^[a-f0-9]{32}$/i,uuid=/^[a-f0-9-]{36}$/i;
const namePat=/^[a-z][a-z0-9-]{2,55}$/;
const domain=/^[a-z0-9.-]+\.[a-z]{2,}$/;
const accessDomainPat=/^[-a-z0-9]+\.cloudflareaccess\.com$/;
const audPat=/^[A-Za-z0-9_-]{20,256}$/;
if(!namePat.test(name)||!namePat.test(d1Name)||!/^[a-z0-9-]{3,63}$/.test(bucket))
  throw new Error("Worker, D1 or bucket name is invalid");
const dry=values["dry-run"];
function runWrangler(argv,{output=false,interactive=false}={}){
  const text="pnpm exec wrangler "+argv.join(" ");
  if(dry){console.log("[dry-run] "+text);return "";}
  const result=spawnSync("pnpm",["exec","wrangler",...argv],{
    stdio:output?"pipe":"inherit",encoding:"utf8",
    env:{...process.env,CLOUDFLARE_ACCOUNT_ID:accountId}
  });
  if(result.error)throw result.error;
  if(result.status!==0)throw new Error("Wrangler failed during "+argv.slice(0,3).join(" "));
  if(output)return result.stdout??"";
  return "";
}
const save=()=>{
 if(dry)return;
 mkdirSync(".flightdeck",{recursive:true,mode:0o700});
 const value={accountId,name,bucket,d1Name,d1Id,streamId,host,accessDomain,accessAud,
   adminEmail,lastUpdatedAt:new Date().toISOString()};
 writeFileSync(statePath,JSON.stringify(value,null,2)+"\n",{mode:0o600});
 chmodSync(statePath,0o600);
};
console.log("\nFLIGHTDECK · ACCOUNT-OWNED SETUP");
console.log("The CLI uses your Wrangler login; no Flightdeck-hosted service is involved.");
console.log("All remote mutations are explicit. Basin/Access permissions may require account admin approval.");
if(dry){
 console.log("\nDry-run plan only. No network calls or files are written.");
 console.log("1. Verify account and Workers Paid/Basin availability");
 console.log("2. Select/create D1 metadata database, use an existing R2 Catalog/Basin stream");
 console.log("3. Verify Cloudflare Access team domain, application AUD and allowed administrator");
 console.log("4. Deploy locked-down Core + Console and apply migrations using workspace:deploy");
 console.log("5. Validate anonymous denial and service-binding ingestion; configure optional admin MCP");
 console.log("[dry-run] pnpm exec wrangler whoami");
 console.log("[dry-run] pnpm workspace:deploy -- --dry-run ...");
 rl?.close();process.exit(0);
}
runWrangler(["whoami"]);
let acct=accountId;
if(!acct)acct=await ask("Cloudflare account ID (32 hex characters)");
requireString(acct,"Cloudflare account ID",id);
// Account name/value is immutable after selecting for this wizard invocation.
const chosenAccount=acct;
accountId=chosenAccount;
if(!process.env.CLOUDFLARE_ACCOUNT_ID)
 console.log("Note: set CLOUDFLARE_ACCOUNT_ID="+chosenAccount+" for other Wrangler commands.");
// Keep the selected account fixed across every subprocess.
const defaultD1=d1Name;
if(!d1Id){
 const choice=await choose("D1 metadata database",["Use existing database UUID","Create new D1 database"],0);
 if(choice==="Create new D1 database"){
   if(!rl)throw new Error("Noninteractive setup requires --d1-id");
   const approval=await ask("Type CREATE_D1 to create "+defaultD1);
   if(approval!=="CREATE_D1")throw new Error("D1 creation cancelled");
   runWrangler(["d1","create",defaultD1]);
 }
 try{
   const output=runWrangler(["d1","list","--json"],{output:true});
   const payload=JSON.parse(output);
   const databases=Array.isArray(payload)?payload:
     Array.isArray(payload?.result)?payload.result:[];
   const match=databases.filter(d=>d?.name===defaultD1);
   if(match.length===1 && uuid.test(match[0].uuid??match[0].id??"")){
     d1Id=match[0].uuid??match[0].id;
     console.log("Detected D1 UUID for "+defaultD1+": "+d1Id);
   }
 }catch(err){
   console.warn("Could not auto-discover D1 UUID: "+String((err).message??err).slice(0,160));
 }
 if(!d1Id)d1Id=await ask("D1 database UUID");
}
requireString(d1Id,"D1 database UUID",uuid);
save();
if(!streamId){
 console.log("\nBASIN PIPELINES");
 console.log("A Basin Catalog pipeline stream is required for historical analytics.");
 console.log("Wrangler's official pipeline setup wizard creates the R2 bucket/catalog when necessary.");
 const choice=await choose("Choose stream provisioning",["Use an existing stream","Run Cloudflare Basin pipeline setup"],0);
 if(choice==="Run Cloudflare Basin pipeline setup"){
   if(!rl)throw new Error("Noninteractive setup requires --stream-id");
   const approval=await ask("Type CREATE_PIPELINE to launch the Cloudflare wizard");
   if(approval!=="CREATE_PIPELINE")throw new Error("Pipeline setup cancelled");
   runWrangler(["basin","pipelines","setup"]);
 }
 streamId=await ask("Basin stream ID (from Wrangler output)");
}
requireString(streamId,"Basin stream ID",/^[A-Za-z0-9_-]{4,128}$/);
save();
if(!host)host=await ask("Console custom hostname (must be on a Cloudflare-managed zone)");
if(!adminEmail)adminEmail=await ask("Admin email for the Access application");
if(!accessDomain||!accessAud){
  const wantsProvision=values["auto-access"]||(rl&&
    (await ask("Provision Cloudflare Access with cf CLI? (yes/no)","no")).toLowerCase()==="yes");
  if(wantsProvision){
    if(!/^[-a-z0-9]+\.[a-z]{2,}$/.test(host)||!adminEmail)
      throw new Error("Host and admin email required for Access provisioning");
    const approval=values.yes?"PROVISION_ACCESS":
      await ask("Type PROVISION_ACCESS to configure a Cloudflare Access policy and application");
    if(approval!=="PROVISION_ACCESS")throw new Error("Access provisioning cancelled");
    const command=["scripts/access-provision.mjs",
      "--account-id",chosenAccount,"--host",host,"--email",adminEmail,"--apply",
      ...(values["bootstrap-zero-trust"]?["--bootstrap-zero-trust"]:[])
    ];
    const proc=spawnSync(process.execPath,command,{
      encoding:"utf8",env:{...process.env,CLOUDFLARE_ACCOUNT_ID:chosenAccount}
    });
    if(proc.error)throw proc.error;
    if(proc.status!==0)throw new Error("Access provisioning failed: "+(proc.stderr??"").slice(0,500));
    const match=(proc.stdout??"").match(/^FLIGHTDECK_ACCESS_RESULT=(\{.*\})$/m);
    if(!match)throw new Error("Access provisioning did not return application configuration");
    const provisioned=JSON.parse(match[1]);
    accessDomain=provisioned.accessDomain;
    accessAud=provisioned.accessAud;
    console.log("Access policy and application configured for "+host);
  }
}
if(!accessDomain)accessDomain=await ask("Access team domain (e.g. company.cloudflareaccess.com)");
if(!accessAud)accessAud=await ask("Existing Access application's AUD tag");
requireString(host,"Console hostname",domain);
requireString(accessDomain,"Access team domain",accessDomainPat);
requireString(accessAud,"Access AUD",audPat);
requireString(adminEmail,"Admin email",/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/);
save();
console.log("\nPREDEPLOY SECURITY REVIEW");
console.log("  Cloudflare account: "+chosenAccount);
console.log("  Basin stream: "+streamId+" · catalog bucket: "+bucket);
console.log("  D1: "+d1Name+" / "+d1Id);
console.log("  Console: https://"+host);
console.log("  Access: "+accessDomain+" · admin "+adminEmail);
console.log("  Core will have no public workers.dev route.");
console.log("  Console refuses access without a valid Cloudflare Access JWT.");
const shouldDeploy=await ask("Type DEPLOY to apply migrations, deploy Workers and install secrets");
if(shouldDeploy!=="DEPLOY"){
 console.log("Configuration saved in "+statePath+". Resume with pnpm wizard -- --resume");
 rl?.close();process.exit(0);
}
if(!process.env.FLIGHTDECK_BASIN_SQL_TOKEN)
 throw new Error("Set FLIGHTDECK_BASIN_SQL_TOKEN from a restricted account token before deploying");
const command=[
  "scripts/workspace-deploy.mjs",
  "--d1-id",d1Id,"--d1-name",d1Name,"--stream-id",streamId,"--account-id",chosenAccount,
  "--bucket",bucket,"--host",host,"--access-domain",accessDomain,"--access-aud",accessAud,
  "--admin-email",adminEmail,"--name",name,"--apply","--yes"
];
const apply=spawnSync(process.execPath,command,{stdio:"inherit",env:{
  ...process.env,CLOUDFLARE_ACCOUNT_ID:chosenAccount
}});
if(apply.error)throw apply.error;
if(apply.status!==0)throw new Error("Deployment failed; inspect state and resume instead of starting over");
console.log("\nDEPLOYMENT COMMANDS COMPLETE");
console.log("Next: pnpm workspace:doctor");
console.log("Then open https://"+host+"/#admin and register application sources.");
console.log("Verify real Basin SQL data, a denied anonymous request, and app-to-Core RPC before production use.");
rl?.close();

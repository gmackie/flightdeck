#!/usr/bin/env node
/**
 * Explicit opt-in Cloudflare Access provisioner based on the new cf CLI.
 * This does not create any public bypass policy. Idempotent by distinct name.
 * Requires 'cf auth login' and scopes to manage Access resources.
 */
import {spawnSync} from "node:child_process";
import {parseArgs} from "node:util";
import process from "node:process";
const {values}=parseArgs({args:process.argv.slice(2).filter(x=>x!=="--"),options:{
 "account-id":{type:"string"},"host":{type:"string"},"email":{type:"string"},
 "team-name":{type:"string"},"bootstrap-zero-trust":{type:"boolean",default:false},"dry-run":{type:"boolean",default:false},
 "apply":{type:"boolean",default:false},help:{type:"boolean",default:false}
}});
if(values.help){
 console.log("Usage: pnpm access:provision -- --account-id ACCOUNT --host analytics.example.com --email admin@example.com [--team-name team] [--dry-run|--apply]");
 process.exit(0);
}
const account=values["account-id"]??"",host=values.host??"",email=(values.email??"").toLowerCase();
const team=values["team-name"]??host.split(".")[0]??"";
if(!/^[a-f0-9]{32}$/i.test(account)||!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)||
   !/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(email)||!/^[a-z0-9-]{2,32}$/.test(team))
 throw new Error("Account, host, email or team name invalid");
const prefix="flightdeck "+host;
const dry=values["dry-run"]||!values.apply;
const plan=[
 "Ensure Zero Trust organization exists (or require explicit first-time creation)",
 "Ensure at least one identity provider is configured",
 "Create or reuse Access allow policy for "+email,
 "Create or reuse a self-hosted Access application for "+host,
 "Return team domain and application audience for locked-down Worker deployment"
];
console.log(JSON.stringify({account,host,email,team,mutating:!dry,steps:plan},null,2));
if(dry){
 console.log("Dry-run: no Cloudflare calls made. To provision use --apply after cf auth login.");
 process.exit(0);
}
const env={...process.env,CLOUDFLARE_ACCOUNT_ID:account};
function cf(args){
 const result=spawnSync("cf",args,{encoding:"utf8",env,stdio:["ignore","pipe","pipe"]});
 if(result.error){
  if(result.error.code==="ENOENT")throw new Error("Cloudflare cf CLI not installed. Install it or configure Access manually.");
  throw result.error;
 }
 if(result.status!==0)throw new Error("cf "+args.slice(0,3).join(" ")+" failed: "+(result.stderr??"").slice(0,800));
 const raw=(result.stdout??"").trim();
 if(!raw)return null;
 try{return JSON.parse(raw);}catch{throw new Error("cf returned unexpected non-JSON output");}
}
function maybe(args){
 try{return cf(args);}catch(error){
  if(/404|not found|does not exist/i.test(String(error)))return null;
  throw error;
 }
}
const organization=maybe(["zero-trust","organization","get"]);
if(!organization?.auth_domain){
 throw new Error("No Cloudflare Zero Trust organization. Enable Zero Trust and choose team domain in dashboard before rerunning.");
}
const domain=String(organization.auth_domain);
if(!/^[-a-z0-9]+\.cloudflareaccess\.com$/.test(domain))
 throw new Error("Access organization returned an invalid auth domain");
const idps=cf(["zero-trust","identity-providers","list"]);
if(!Array.isArray(idps))throw new Error("Unexpected identity provider listing");
if(!idps.length){
 if(!newOrganization||!values["bootstrap-zero-trust"])
  throw new Error("Configure an identity provider in Cloudflare Zero Trust before proceeding.");
 cf(["zero-trust","identity-providers","create","--body",JSON.stringify({
   name:"Flightdeck one-time PIN",type:"onetimepin",config:{}
 })]);
}
const policies=cf(["zero-trust","access","policies","list"]);
if(!Array.isArray(policies))throw new Error("Unexpected Access policy listing");
let policy=policies.find(p=>p?.name===prefix+": administrators");
if(!policy){
 policy=cf(["zero-trust","access","policies","create","--body",JSON.stringify({
  name:prefix+": administrators",decision:"allow",include:[{email:{email}}]
 })]);
}
if(typeof policy?.id!=="string")throw new Error("Failed to provision Access allow policy");
const applications=cf(["zero-trust","access","applications","list"]);
if(!Array.isArray(applications))throw new Error("Unexpected Access application listing");
let app=applications.find(a=>a?.name===prefix);
const appBody={type:"self_hosted",name:prefix,destinations:[{type:"public",uri:host}],
 policies:[policy.id],session_duration:"24h",app_launcher_visible:true};
if(app){
  // Do not silently overwrite another application's hostname/policies.
  if(app.name!==prefix)throw new Error("Access app name collision");
  app=cf(["zero-trust","access","applications","update",app.id,"--body",JSON.stringify(appBody)]);
}else app=cf(["zero-trust","access","applications","create","--body",JSON.stringify(appBody)]);
if(typeof app?.aud!=="string"||!/^[A-Za-z0-9_-]{20,256}$/.test(app.aud))
 throw new Error("Access app did not return a valid audience; inspect it in the dashboard");
console.log("FLIGHTDECK_ACCESS_RESULT="+JSON.stringify({
 accessDomain:domain,accessAud:app.aud,host,policyId:policy.id,applicationId:app.id
}));

#!/usr/bin/env node
/**
 * Flightdeck universal self-hosted Cloudflare account wizard.
 * Run from repository root: pnpm install:cloudflare
 *
 * The wizard never sends data to a Flightdeck-operated service.
 */
import {parseArgs} from "node:util";
import {createInterface} from "node:readline/promises";
import {Shell,Manifest,InstallerError,validateInstallOptions,slugPattern} from "./install/engine.mjs";
import {CloudflareApi,chooseAccount} from "./install/cloudflare.mjs";
import {installationPlan,applyWizard} from "./install/wizard.mjs";

const {values}=parseArgs({args:process.argv.slice(2).filter(x=>x!=="--"),options:{
  "account-id":{type:"string"},"slug":{type:"string"},
  "admin-emails":{type:"string"},
  mode:{type:"string"},
  "skip-mcp":{type:"boolean",default:false},
  "enable-ai":{type:"boolean",default:false},
  "query-units":{type:"string"},
  apply:{type:"boolean",default:false},
  yes:{type:"boolean",default:false},
  "dry-run":{type:"boolean",default:false},
  help:{type:"boolean",default:false}
}});
if(values.help){
 console.log(`Flightdeck account-owned installation wizard
Usage: pnpm install:cloudflare -- [options]

--account-id ID    Cloudflare account, or select interactively
--slug NAME        Unique deployment suffix (default: default)
--admin-emails X   Comma-separated Access email allowlist
--mode MODE        standard | intelligence (default: intelligence)
--skip-mcp         Do not deploy the optional MCP Worker
--enable-ai        Enable Workers AI interpretation (default off)
--query-units N    Monthly relative query admission budget
--dry-run          Print plan, with zero provider mutations
--apply            Explicitly request deployment; interactive approval required
--yes              Noninteractive apply, only with --apply
--help             Show this help

Requirements: Cloudflare Workers Paid, R2, Zero Trust, Node 22.18+, pnpm.
For full unattended Basin provisioning set CLOUDFLARE_API_TOKEN and
FLIGHTDECK_CATALOG_TOKEN in the calling environment.
Without API credentials, the wizard can use cf/Wrangler sign-in and launch
Cloudflare's native interactive Basin setup subwizard.
`);
 process.exit(0);
}
const interactive=!!process.stdin.isTTY&&!values.yes;
const rl=interactive?createInterface({input:process.stdin,output:process.stdout}):null;
const ask=async(label,fallback="")=>{
 if(!rl)return fallback;
 const value=(await rl.question("  "+label+(fallback?" ["+fallback+"]":"")+": ")).trim();
 return value||fallback;
};
const shell=new Shell({secretValues:[process.env.CLOUDFLARE_API_TOKEN,process.env.FLIGHTDECK_CATALOG_TOKEN].filter(Boolean)});
shell.log=message=>console.log(message);
let api=new CloudflareApi({accountId:values["account-id"]??""});
async function main(){
 const manifest=new Manifest();
 console.log("\n◆ Flightdeck · Deploy to your Cloudflare account");
 console.log("  Account-owned analytics, admin console, and optional MCP/Journey Workers");
 console.log("  No Flightdeck-hosted SaaS, no mandatory public analytics collector.\n");
 if(process.versions.node.split(".").map(Number)[0]<22)
   throw new InstallerError("unsupported_node","Node.js 22+ is required");
 if(!values["dry-run"]&&!shell.exec("pnpm",["--version"],{allowFailure:true}).ok)
   throw new InstallerError("pnpm_unavailable","Install pnpm 10+ before using this wizard");
 // Prefer the existing Wrangler OAuth session over requiring another account token.
 if(!values["dry-run"]&&!api.enabled){
   const auth=shell.wrangler(["auth","token","--json"],{allowFailure:true});
   if(auth.ok){
     try{
       const credential=JSON.parse(auth.stdout);
       if(typeof credential.token==="string"&&credential.token.length>=20){
         api=new CloudflareApi({accountId:values["account-id"]??"",token:credential.token});
         shell.secretValues.push(credential.token);
       }
     }catch{/* Legacy Wrangler falls back to native CLI authentication. */}
   }
 }
 if(!values["dry-run"]&&!api.enabled){
   const cf=shell.cf(["auth","whoami"],{allowFailure:true});
   if(!cf.ok){
     if(!interactive)throw new InstallerError("cf_login_required",
       "Run 'cf auth login' or provide CLOUDFLARE_API_TOKEN");
     console.log("  Authenticate with Cloudflare CLI:");
     shell.interactive("cf",["auth","login"]);
   }
   const wr=shell.wrangler(["whoami","--json"],{allowFailure:true});
   if(!wr.ok){
     if(!interactive)throw new InstallerError("wrangler_login_required",
       "Run 'pnpm exec wrangler login' or provide CLOUDFLARE_API_TOKEN");
     console.log("  Authenticate Wrangler against the same Cloudflare account:");
     shell.interactive("pnpm",["exec","wrangler","login"]);
   }
 }
 let accountId=values["account-id"]??manifest.state.accountId;
 if(values["dry-run"]&&!accountId)
   throw new InstallerError("account_required","Dry-run needs --account-id; it does not query connected accounts.");
 if(!values["dry-run"]){
   const account=await chooseAccount({shell,api,ask:interactive?ask:null,preferred:accountId});
   accountId=account.id;
   api.accountId=accountId;
   shell.log("  Account: "+account.name);
 }
 const slug=values.slug??await ask("Installation name (letters/numbers/hyphens)",
   manifest.state.slug??"default");
 if(!slugPattern.test(slug))throw new InstallerError("invalid_slug");
 const admins=values["admin-emails"]??await ask("Who may administer Flightdeck? (emails)",
   manifest.state.adminEmails?.join(",")??"");
 const mode=values.mode??await ask("Install mode: standard or intelligence","intelligence");
 const enableAI=values["enable-ai"] || (mode==="intelligence" && interactive &&
   (await ask("Enable paid Workers AI analysis? (y/N)","n")).toLowerCase()==="y");
 const queryUnits=values["query-units"]===undefined?50000:Number(values["query-units"]);
 if(!Number.isSafeInteger(queryUnits)||queryUnits<0||queryUnits>100_000_000)
   throw new InstallerError("invalid_query_budget");
 const input={
   accountId,slug,adminEmails:admins,mode,
   enableAI,enableMcp:!values["skip-mcp"],queryUnits
 };
 const plan=installationPlan(input);
 console.log("\n◆ Installation plan");
 console.log("  Account: "+accountId);
 console.log("  Deployment: "+slug+" ("+mode+")");
 console.log("  Access admin allowlist: "+plan.adminEmails.join(", "));
 console.log("  Changes:");
 plan.steps.forEach((x,i)=>console.log("    "+(i+1)+". "+x));
 console.log("\n  Cloudflare usage charges may apply.");
 console.log("  Source tokens and SQL credentials stay in your account/local secure store.");
 console.log("  This is a developer beta; complete the release validation before sensitive traffic.\n");
 if(values["dry-run"]){
   console.log("Dry run: No Cloudflare resources were created and no installation files were written.");
   return;
 }
 if(!values.apply){
   if(!interactive){
     console.log("No mutations performed. Add --apply --yes after reviewing the plan.");
     return;
   }
   const approval=await ask("Type INSTALL to create/configure resources","");
   if(approval!=="INSTALL"){
     console.log("Installation cancelled with no mutations.");
     return;
   }
 }else if(interactive&&!values.yes){
   const approval=await ask("Type INSTALL to approve remote resource creation","");
   if(approval!=="INSTALL"){
     console.log("Cancelled before mutations.");
     return;
   }
 }
 manifest.state.adminEmails=plan.adminEmails;
 manifest.state.mode=mode;
 manifest.save();
 const result=await applyWizard({
   input,manifest,shell,api,
   prompt:interactive?ask:null,
   logger:msg=>console.log(msg),
 });
 console.log("\n✓ Flightdeck deployed; anonymous access denial verified");
 console.log("  Console: "+result.consoleUrl);
 if(result.mcpUrl)console.log("  MCP: "+result.mcpUrl);
 console.log("  Default application source: "+result.sourceId);
 console.log("  Local source token recovery file: "+result.sourceTokenFile);
 console.log("  Service binding (add to your application wrangler.jsonc):");
 console.log('    {"services":[{"binding":"FLIGHTDECK","service":"'+
   "flightdeck-"+slug+'-core"}]}');
 console.log("  Add the source ID and token to each consuming Worker as secrets.");
 console.log("\nNext: register additional Workers/DOs from Flightdeck Admin, then");
 console.log("complete authenticated health and event → Basin SQL verification using docs/demo.md.");
}
main().catch(error=>{
 console.error("\n✗ "+(error?.message??String(error)));
 console.error("  The wizard records completed steps. Fix the problem and rerun.");
 process.exitCode=1;
}).finally(()=>rl?.close());

#!/usr/bin/env node
import {parseArgs} from "node:util";
import {randomBytes,createHash} from "node:crypto";
import {readFileSync,writeFileSync,mkdirSync,existsSync,unlinkSync} from "node:fs";
import {Shell} from "./install/engine.mjs";
import {demoSources} from "./verify-demo.mjs";

const {values}=parseArgs({options:{apply:{type:"boolean"},"dry-run":{type:"boolean"},help:{type:"boolean"}}});
if(values.help){
  console.log("node scripts/setup-demo.mjs --dry-run | --apply\nRegisters two synthetic demo sources in the installed project's D1 registry. Keeps generated app credentials in .flightdeck/demo-secrets.json (0600), never stdout.");
  process.exit(0);
}
if(values.apply&&values["dry-run"])throw new Error("Choose --apply or --dry-run");
const path=".flightdeck/demo-secrets.json";
if(!values.apply){
  console.log(JSON.stringify({apply:false,project:"default",sources:Object.entries(demoSources).map(([name,events])=>({id:"demo-"+name,events,consentRequired:true,environment:"staging"})),credentials:path},null,2));
}else{
  const install=JSON.parse(readFileSync(".flightdeck/install.json","utf8"));
  if(!install.resources?.d1Name||!install.resources?.d1Id)throw new Error("Install Flightdeck before registering sources");
  mkdirSync(".flightdeck",{recursive:true,mode:0o700});
  const secrets=existsSync(path)?JSON.parse(readFileSync(path,"utf8")):{accountId:install.accountId,demoToken:randomBytes(32).toString("base64url"),sources:{}};
  if(secrets.accountId!==install.accountId)throw new Error("Demo credentials belong to another account");
  const quote=value=>"'"+String(value).replaceAll("'","''")+"'";
  const statements=[];
  const expected=new Map();
  for(const [source,events] of Object.entries(demoSources)){
    const id="demo-"+source;
    secrets.sources[source]??={id,token:randomBytes(32).toString("base64url")};
    const digest=createHash("sha256").update(secrets.sources[source].token).digest("hex");
    const policy={allowedEvents:events,allowedProperties:Object.fromEntries(events.map(e=>[e,["demo","stage"]])),
      allowedKinds:["product"],allowedEnvironments:["staging"],consentRequired:true,
      maxBatchSize:10,maxBatchBytes:16384,graphEnabled:false};
    expected.set(id,{digest,policy});
    // Existing registrations are never silently rotated or overwritten.
    statements.push(`INSERT INTO sources(id,project_id,display_name,enabled,token_sha256,policy_json) VALUES(${quote(id)},'default',${quote(source+" synthetic demo")},1,${quote(digest)},${quote(JSON.stringify(policy))}) ON CONFLICT(id) DO NOTHING;`);
  }
  writeFileSync(path,JSON.stringify(secrets,null,2)+"\n",{mode:0o600});
  const sqlPath=".flightdeck/demo-source-seed.sql";
  writeFileSync(sqlPath,statements.join("\n"),{mode:0o600});
  try{
    const shell=new Shell({env:{...process.env,CLOUDFLARE_ACCOUNT_ID:install.accountId}});
    shell.wrangler([
      "d1","execute",install.resources.d1Name,"--remote","--config","apps/console/wrangler.generated.jsonc","--file",sqlPath,"--yes"]);
    const result=shell.wranglerJSON(["d1","execute",install.resources.d1Name,"--remote",
      "--config","apps/console/wrangler.generated.jsonc","--command",
      "SELECT id, project_id, enabled, token_sha256, policy_json FROM sources WHERE id IN ('demo-forgegraph','demo-wafflehouse')","--json"]);
    const rows=result.flatMap(item=>item.results??[]);
    for(const [id,{digest,policy}] of expected){
      const row=rows.find(row=>row.id===id);
      if(!row||row.project_id!=="default"||row.enabled!==1||row.token_sha256!==digest||
        JSON.stringify(JSON.parse(row.policy_json))!==JSON.stringify(policy))
        throw new Error("Demo source ownership or policy mismatch for "+id+"; recover its original credentials or explicitly migrate it before deployment.");
    }
  }finally{unlinkSync(sqlPath);}
  console.log("Demo source credentials and policies verified. Credentials saved privately to "+path+".");
}

/**
 * Wizard orchestration. All Cloudflare mutations require apply=true. Stages
 * are persisted after success so a failed install can resume safely.
 */
import {readFileSync,writeFileSync,existsSync,chmodSync,mkdirSync,unlinkSync,readdirSync} from "node:fs";
import {randomBytes,createHash} from "node:crypto";
import {Shell,Manifest,InstallerError,workerHost,validateInstallOptions} from "./engine.mjs";
import {CloudflareApi,chooseAccount,ensureAccess,ensureWorkersSubdomain} from "./cloudflare.mjs";
import {ensureD1,ensureR2Bucket,ensureCatalog,ensureBasin,ensureQueues} from "./basin.mjs";
import {buildConfigs,writeConfigs,assertLocked,assertReady} from "./config.mjs";
import {preflightAccount} from "./preflight.mjs";

const consolePath="apps/console/wrangler.generated.jsonc";
const corePath="apps/core/wrangler.generated.jsonc";
const journeyPath="apps/journey/wrangler.generated.jsonc";
const mcpPath="apps/mcp/wrangler.generated.jsonc";
const metadataDir=".flightdeck";
const localCreds=metadataDir+"/credentials.json";
const hash=x=>createHash("sha256").update(x).digest("hex");
const now=()=>new Date().toISOString();
function loadCredentials(){
  return existsSync(localCreds)?JSON.parse(readFileSync(localCreds,"utf8")):{};
}
function saveCredentials(credentials){
  mkdirSync(metadataDir,{recursive:true,mode:0o700});
  writeFileSync(localCreds,JSON.stringify(credentials,null,2)+"\n",{mode:0o600});
  chmodSync(localCreds,0o600);
}
function sourcePolicy(){
  return {
    allowedEvents:["page.viewed","project.opened","project.created","identity.identified","feature.exposed","rum.*"],
    allowedProperties:{
      "page.viewed":["route"],"project.opened":["template"],"project.created":["template"],
      "identity.identified":[],
      "feature.exposed":["flagKey","variant","experimentId"],
      "rum.*":["value","rating","metricId"],
    },
    allowedKinds:["product","rum","exposure","agent","error"],
    allowedEnvironments:["production","staging"],enabled:true,graphEnabled:true,
    consentRequired:false,maxBatchSize:100,maxBatchBytes:256000,
  };
}
function sqlEsc(x){return "'"+String(x).replaceAll("'","''")+"'";}
function sourceSeedSQL(names,creds,projectId="default"){
  const id=names.source,token=creds.sourceToken;
  if(!token||token.length<32)throw new Error("Source secret unavailable");
  const secretHash=hash(token),policy=JSON.stringify(sourcePolicy());
  return [
    "INSERT OR IGNORE INTO projects(id,name) VALUES("+sqlEsc(projectId)+","+sqlEsc("Flightdeck")+");",
    "INSERT OR IGNORE INTO sources(id,project_id,display_name,enabled) VALUES("+
       sqlEsc(id)+","+sqlEsc(projectId)+","+sqlEsc("Default application")+ ",1);",
    "UPDATE sources SET token_sha256="+sqlEsc(secretHash)+
      ",policy_json="+sqlEsc(policy)+",enabled=1 WHERE id="+sqlEsc(id)+
      " AND project_id="+sqlEsc(projectId)+" AND token_sha256 IS NULL;",
  ].join("\n");
}
function ensureCredentials(){
  const current=loadCredentials();
  if(!current.sourceToken)current.sourceToken=randomBytes(32).toString("base64url");
  if(!current.journeyToken)current.journeyToken=randomBytes(32).toString("base64url");
  saveCredentials(current);
  return current;
}
function ensureNoSecrets(cfg){
  const serialized=JSON.stringify(cfg);
  if(/SOURCE_CREDENTIALS|BASIN_SQL_TOKEN.*[a-z0-9]{40}/i.test(serialized))
    throw new Error("Configuration appears to contain credentials");
}
/** Hash deployable source/config, never local credentials or generated artifacts. */
function deploymentRevision(input){
  const digest=createHash("sha256");
  const ignored=new Set(["node_modules","dist",".wrangler",".vite","dist-packages"]);
  function visit(path){
    if(!existsSync(path))return;
    for(const entry of readdirSync(path,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
      if(ignored.has(entry.name)||entry.name.startsWith(".")||entry.name.includes(".generated."))continue;
      const file=path+"/"+entry.name;
      if(entry.isDirectory())visit(file);
      else if(entry.isFile()&&!entry.name.endsWith(".test.ts")&&!entry.name.endsWith(".test.mjs")){
        digest.update(file+"\0");digest.update(readFileSync(file));
      }
    }
  }
  for(const path of ["apps","packages","scripts","migrations","basin"])visit(path);
  for(const path of ["package.json","pnpm-lock.yaml","pnpm-workspace.yaml"])
    if(existsSync(path)){digest.update(path+"\0");digest.update(readFileSync(path));}
  digest.update(JSON.stringify(input));
  return digest.digest("hex");
}
function prepareRevision(manifest,revision){
  if(manifest.state.targetRevision===revision)return;
  // Provisioned identities survive upgrades; revision-specific work does not.
  for(const step of ["migrations","private_core","journey","locked_console","locked_mcp",
    "console_final","mcp_final","verified","deployed"])
    delete manifest.state.steps[step];
  manifest.state.targetRevision=revision;
  manifest.save();
}
function loggedStep(label,fn,{manifest,logger=console.log}){
  if(manifest.has(label)){
    logger("  ✓ "+label+" (recorded, skipped)");
    return Promise.resolve(manifest.resources);
  }
  return Promise.resolve().then(async()=>{
    logger("  ◆ "+label);
    const patch=await fn();
    manifest.mark(label,patch??{});
    logger("  ✓ "+label);
    return manifest.resources;
  });
}
export function installationPlan(input){
  const options=validateInstallOptions(input),n=options.names;
  return {
    accountId:options.accountId,slug:options.slug,adminEmails:options.adminEmails,
    mode:options.mode,resources:{
      core:n.core,console:n.console,journey:n.journey,mcp:n.mcp,
      metadataD1:n.database,r2CatalogBucket:n.bucket,
      basinStream:n.stream,basinSink:n.sink,basinPipeline:n.pipeline,
      queue:n.queue,deadLetterQueue:n.dlq,
    },
    steps:[
      "Verify D1, R2, Basin, optional Queues, and Workers account permissions before resource mutations",
      "Provision project-scoped D1 metadata",
      "Create R2 bucket + Basin Catalog",
      "Create authenticated Worker-binding Basin stream, Catalog sink and SQL pipeline",
      ...(options.mode==="intelligence"?["Create live journey Queues"]:[]),
      "Apply D1 migrations and initialize default source policy",
      "Deploy console (+ optional MCP) locked before any Access policy exists",
      "Create/reuse dedicated Zero Trust Access org, admin policy and application",
      "Deploy private Analytics Core, optional Journey Durable Objects and locked MCP",
      "Deploy Access-bound Console and MCP with no bypass paths",
      "Verify anonymous HTML/API requests are denied and report readiness",
    ],
    requirements:["Workers Paid","R2 enabled","Zero Trust Access",
      "Basin Catalog token","Wrangler login","Cloudflare CLI login or API token"],
  };
}
function writeSourceSeed(shell,names,creds){
  const path=metadataDir+"/seed.sql";
  writeFileSync(path,sourceSeedSQL(names,creds),{mode:0o600});
  try{
    shell.wrangler(["d1","execute",names.database,"--remote",
      "--file",path,"--config",consolePath,"--yes"]);
  }finally{try{unlinkSync(path);}catch{/*already removed*/}}
}
async function accessProbe(host,fetcher=fetch){
  const urls=["/api/config","/index.html"];
  for(const path of urls){
    let response;
    try{
      response=await fetcher("https://"+host+path,{
        redirect:"manual",signal:AbortSignal.timeout(15_000)
      });
    }catch{
      throw new InstallerError("console_probe_failed",
        "Cannot reach the installed console. Verify DNS/Workers deployment and rerun doctor.");
    }
    if(response.status===200)throw new InstallerError("console_access_bypass",
      "SECURITY FAILURE: anonymous request returned HTTP 200 on "+path);
    if(![302,303,307,308,401,403].includes(response.status))
      throw new InstallerError("console_access_unexpected",
        "Unexpected anonymous response "+response.status+" from "+path);
  }
  return true;
}
export async function applyWizard({
  input,manifest=new Manifest(),shell=new Shell(),api,prompt,logger=console.log,
  fetcher=fetch
}){
  const options=validateInstallOptions(input),names=options.names;
  manifest.assertIdentity(options.accountId,options.slug);
  const immutable={adminEmails:options.adminEmails,mode:options.mode,enableMcp:input.enableMcp!==false};
  if(manifest.state.installOptions && JSON.stringify(manifest.state.installOptions)!==JSON.stringify(immutable))
    throw new InstallerError("install_options_changed",
      "Changing administrator access, mode or MCP topology requires an explicit migration; reuse the recorded options.");
  if(manifest.has("bootstrap_source")&&!existsSync(localCreds))
    throw new InstallerError("credentials_missing","Restore the installation credentials from your secure backup; refusing to silently replace source credentials.");
  manifest.state.installOptions=immutable;
  manifest.save();
  // Build failures must happen before any provider resource mutations.
  shell.exec("pnpm",["build"]);
  const revision=deploymentRevision({options,enableAI:input.enableAI===true,
    enableMcp:input.enableMcp!==false,queryUnits:input.queryUnits??50000});
  const upgrading=!!manifest.state.deployedRevision || manifest.has("deployed");
  prepareRevision(manifest,revision);
  const account=options.accountId;
  shell.env.CLOUDFLARE_ACCOUNT_ID=account;
  api??=new CloudflareApi({accountId:account,fetcher});
  const stage=(label,fn)=>loggedStep(label,fn,{manifest,logger});
  const settings={accountId:account,names,adminEmails:options.adminEmails,
    enableJourneys:options.mode==="intelligence",enableMcp:input.enableMcp!==false,
    enableAI:input.enableAI===true,queryUnits:input.queryUnits??50000};
  let creds=ensureCredentials();
  await (async()=>{
    const readiness=await preflightAccount({api,shell,accountId:account,mode:options.mode});
    manifest.mark("preflight",{preflightVerifiedAt:readiness.verifiedAt});
  })();
  if(!manifest.has("basin")&&!prompt&&!(shell.env.FLIGHTDECK_CATALOG_TOKEN?.length>=20))
    throw new InstallerError("basin_token_required",
      "Unattended install needs FLIGHTDECK_CATALOG_TOKEN before resources can be created.");
  await stage("d1",()=>ensureD1({api,shell,names,manifest}));
  await stage("workers_subdomain",()=>ensureWorkersSubdomain({api,shell,accountId:account,manifest}));
  await stage("r2",()=>ensureR2Bucket({api,shell,names,manifest}));
  await stage("catalog",()=>ensureCatalog({shell,names}));
  await stage("basin",()=>ensureBasin({api,shell,names,manifest,prompt,logger}));
  if(settings.enableJourneys)await stage("queues",()=>ensureQueues({shell,names,manifest}));
  const staticConfig=buildConfigs({...settings,
    d1Id:manifest.resources.d1Id,streamId:manifest.resources.streamId,access:null});
  assertLocked(staticConfig);
  ensureNoSecrets(staticConfig);
  writeConfigs(staticConfig);
  await stage("migrations",async()=>{
    // Backup if this isn't a first install; Wrangler tracks applied migrations.
    if(upgrading){
      shell.wrangler(["d1","export",names.database,"--remote",
        "--output",metadataDir+"/preupgrade-"+Date.now()+".sql","--config",consolePath]);
    }
    shell.wrangler(["d1","migrations","apply",names.database,"--remote","--config",consolePath]);
    return {migrationsApplied:true};
  });
  await stage("bootstrap_source",async()=>{
    writeSourceSeed(shell,names,creds);
    return {bootstrapSourceId:names.source};
  });
  // Service-bound targets must exist before Console deploy. Core and Journey
  // are private (workers_dev=false) and safe to deploy before Access.
  await stage("private_core",async()=>{
    shell.wrangler(["deploy","--config",corePath]);
    return {coreWorker:names.core};
  });
  if(settings.enableJourneys)await stage("journey",async()=>{
    shell.wrangler(["deploy","--config",journeyPath]);
    shell.wrangler(["secret","put","JOURNEY_INTERNAL_TOKEN","--config",journeyPath],
      {input:creds.journeyToken+"\n"});
    return {journeyWorker:names.journey};
  });
  await stage("locked_console",async()=>{
    shell.exec("pnpm",["--filter","@flightdeck/console","build"]);
    const result=shell.wrangler(["deploy","--config",consolePath]);
    const host=workerHost(result.stdout+"\n"+result.stderr);
    if(!host)throw new InstallerError("console_host_not_found",
      "Wrangler did not show a workers.dev URL. Configure your account Workers subdomain and rerun.");
    return {consoleHost:host};
  });
  if(settings.enableMcp)await stage("locked_mcp",async()=>{
    const result=shell.wrangler(["deploy","--config",mcpPath]);
    const host=workerHost(result.stdout+"\n"+result.stderr);
    if(!host)throw new InstallerError("mcp_host_not_found","Wrangler did not show an MCP workers.dev URL.");
    return {mcpHost:host};
  });
  let access;
  await stage("access",async()=>{
    access=await ensureAccess({
      shell,api,accountId:account,slug:options.slug,adminEmails:options.adminEmails,
      hosts:[manifest.resources.consoleHost,
        ...(settings.enableMcp?[manifest.resources.mcpHost]:[])],
      manifest
    });
    return {
      accessTeamDomain:access.teamDomain,accessAud:access.aud,
      accessAppId:access.appId,accessPolicyId:access.policyId
    };
  });
  access??={
    teamDomain:manifest.resources.accessTeamDomain,aud:manifest.resources.accessAud,
  };
  const readyConfig=buildConfigs({...settings,
    d1Id:manifest.resources.d1Id,streamId:manifest.resources.streamId,access,
    consoleHost:manifest.resources.consoleHost});
  assertReady(readyConfig,access);writeConfigs(readyConfig);
  // The SQL token must exist before any Worker is published with valid Access.
  const sqlToken=shell.env.FLIGHTDECK_CATALOG_TOKEN;
  if(typeof sqlToken!=="string"||sqlToken.length<20)throw new InstallerError("sql_token_required",
    "Set FLIGHTDECK_CATALOG_TOKEN securely and rerun; all current deployments remain locked.");
  await stage("console_final",async()=>{
    shell.wrangler(["deploy","--config",consolePath]);
    shell.wrangler(["secret","put","BASIN_SQL_TOKEN","--config",consolePath],
      {input:sqlToken+"\n"});
    if(settings.enableJourneys){
      shell.wrangler(["secret","put","JOURNEY_INTERNAL_KEY","--config",consolePath],
        {input:creds.journeyToken+"\n"});
    }
    return {consoleDeployed:true};
  });
  if(settings.enableMcp)await stage("mcp_final",async()=>{
    shell.wrangler(["deploy","--config",mcpPath]);
    return {mcpDeployed:true};
  });
  // Security verification is fresh on every run and distinct from data readiness.
  await accessProbe(manifest.resources.consoleHost,fetcher);
  if(settings.enableMcp)await accessProbe(manifest.resources.mcpHost,fetcher);
  manifest.mark("verified",{verifiedAt:now(),functionalReadiness:"pending"});
  manifest.state.deployedRevision=revision;
  manifest.save();
  manifest.mark("deployed",{});
  return {
    consoleUrl:"https://"+manifest.resources.consoleHost,
    mcpUrl:settings.enableMcp?"https://"+manifest.resources.mcpHost+"/mcp":null,
    sourceId:names.source,sourceTokenFile:localCreds,
    accountId:account,verifiedAt:manifest.resources.verifiedAt,
    functionalReadiness:"pending",revision,
  };
}

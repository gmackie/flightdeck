#!/usr/bin/env node
/**
 * Zero-hosted-infrastructure, localhost-only Cloudflare installation UI.
 * All Cloudflare credentials stay in this user's process environment.
 */
import http from "node:http";
import {spawn,spawnSync} from "node:child_process";
import {readFileSync} from "node:fs";
import {resolve,dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {randomBytes,timingSafeEqual} from "node:crypto";
import {installationPlan} from "./install/wizard.mjs";
import {normalizeList,accountIdPattern} from "./install/engine.mjs";

const projectRoot=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const assets=resolve(projectRoot,"scripts/install");
const portDefault=43217;
const maximumBody=8192;
const headers={
  "X-Content-Type-Options":"nosniff",
  "Cache-Control":"no-store",
  "Referrer-Policy":"no-referrer",
  "Cross-Origin-Resource-Policy":"same-origin",
  "X-Frame-Options":"DENY",
  "Content-Security-Policy":"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
};
const reply=(res,status,body,type="application/json; charset=utf-8")=>{
  res.writeHead(status,{"Content-Type":type,...headers});
  res.end(type.startsWith("application/json")?JSON.stringify(body):body);
};
function safeEqual(a,b){
  if(typeof a!=="string"||typeof b!=="string")return false;
  const x=Buffer.from(a),y=Buffer.from(b);
  return x.length===y.length&&timingSafeEqual(x,y);
}
function parseJson(req){
  return new Promise((resolve,reject)=>{
    let size=0,chunks=[];
    req.on("data",chunk=>{
      size+=chunk.byteLength;
      if(size>maximumBody){
        reject(new Error("request_too_large"));req.destroy();
      }else chunks.push(chunk);
    });
    req.on("end",()=>{
      try{resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));}
      catch{reject(new Error("invalid_json"));}
    });
    req.on("error",reject);
  });
}
export function validateWebInstall(input){
  if(!input||typeof input!=="object"||Array.isArray(input))throw new Error("invalid_install_payload");
  const x=input;
  const plan=installationPlan({
    accountId:x.accountId,slug:x.slug,adminEmails:x.adminEmails,
    mode:x.mode,enableAI:x.enableAI===true,enableMcp:x.enableMcp!==false,
    queryUnits:Number(x.queryUnits??50000)
  });
  if(x.enableAI!==undefined&&typeof x.enableAI!=="boolean")throw new Error("invalid_ai_option");
  if(x.enableMcp!==undefined&&typeof x.enableMcp!=="boolean")throw new Error("invalid_mcp_option");
  if(x.queryUnits!==undefined&&(!Number.isSafeInteger(x.queryUnits)||x.queryUnits<0||
    x.queryUnits>100_000_000))throw new Error("invalid_query_budget");
  return {...plan,options:{
    accountId:plan.accountId,slug:plan.slug,
    adminEmails:plan.adminEmails.join(","),mode:plan.mode,
    enableAI:x.enableAI===true,enableMcp:x.enableMcp!==false,
    queryUnits:Number(x.queryUnits??50000)
  }};
}
function redactor(secrets){
  return text=>{
    let s=String(text);
    for(const secret of secrets){
      if(typeof secret==="string"&&secret.length>=8)s=s.split(secret).join("[redacted]");
    }
    return s.replaceAll(/Bearer\s+[A-Za-z0-9._-]{20,}/gi,"Bearer [redacted]");
  };
}
function accountsFromEnvironment(env){
  const token=env.CLOUDFLARE_API_TOKEN;
  return token&&token.length>=20;
}
export function createInstallerServer(options={}){
  const secret=options.secret??randomBytes(32).toString("base64url");
  const env=options.env??process.env;
  const processLauncher=options.spawn??spawn;
  const listAccounts=options.accounts??(async()=>{
    if(accountsFromEnvironment(env)){
      const response=await fetch("https://api.cloudflare.com/client/v4/accounts",{
        headers:{Authorization:"Bearer "+env.CLOUDFLARE_API_TOKEN},signal:AbortSignal.timeout(15_000)
      });
      if(!response.ok)throw new Error("Cloudflare account listing unavailable: "+response.status);
      const payload=await response.json();
      return normalizeList(payload);
    }
    const cf=spawnSync("cf",["accounts","list"],{
      cwd:projectRoot,env,encoding:"utf8",maxBuffer:3_000_000
    });
    if(cf.status!==0)throw new Error("Run cf auth login or configure CLOUDFLARE_API_TOKEN");
    return normalizeList(JSON.parse(cf.stdout));
  });
  const state={
    running:false,done:false,success:false,error:null,logs:[],
    startedAt:null,finishedAt:null,options:null
  };
  let child=null;
  const clean=redactor([env.CLOUDFLARE_API_TOKEN,env.FLIGHTDECK_CATALOG_TOKEN]);
  const log=value=>{
    const line=clean(value).replace(/\u001b\[[0-9;]*m/g,"");
    for(const part of line.split(/\r?\n/)){
      if(!part.trim())continue;
      state.logs.push(part.slice(0,600));
    }
    if(state.logs.length>400)state.logs.splice(0,state.logs.length-400);
  };
  const server=http.createServer(async(req,res)=>{
    const host=req.headers.host??"";
    const port=server.address()?.port??options.port??portDefault;
    const origin="http://127.0.0.1:"+port;
    // Prevent DNS rebinding and requests sent through unrelated local hostnames.
    if(host!=="127.0.0.1:"+port){reply(res,403,{error:"invalid_host"});return;}
    const url=new URL(req.url??"/",origin);
    if(req.method==="GET"&&["/","/ui.js","/ui.css"].includes(url.pathname)){
      const files={"/":"ui.html","/ui.js":"ui.js","/ui.css":"ui.css"};
      const type=url.pathname==="/"?"text/html; charset=utf-8":
        url.pathname==="/ui.js"?"text/javascript; charset=utf-8":"text/css; charset=utf-8";
      const content=readFileSync(resolve(assets,files[url.pathname]),"utf8");
      reply(res,200,url.pathname==="/"?content.replace("__FLIGHTDECK_CSRF__",secret):content,type);
      return;
    }
    if(!url.pathname.startsWith("/api/")){
      reply(res,404,{error:"not_found"});return;
    }
    const header=req.headers["x-flightdeck-csrf"];
    if(!safeEqual(Array.isArray(header)?header[0]:header,secret)){
      reply(res,403,{error:"csrf_required"});return;
    }
    if(req.method!=="GET"){
      if(req.headers.origin!==origin){reply(res,403,{error:"origin_not_allowed"});return;}
      if(!req.headers["content-type"]?.startsWith("application/json")){
        reply(res,415,{error:"invalid_content_type"});return;
      }
    }
    try{
      if(req.method==="GET"&&url.pathname==="/api/prerequisites"){
        reply(res,200,{
          node:process.versions.node,
          cloudflareApiTokenConfigured:!!accountsFromEnvironment(env),
          catalogTokenConfigured:!!(env.FLIGHTDECK_CATALOG_TOKEN&&env.FLIGHTDECK_CATALOG_TOKEN.length>=20),
          steps:["Account","Options","Review","Install"]
        });return;
      }
      if(req.method==="GET"&&url.pathname==="/api/accounts"){
        const rows=(await listAccounts()).filter(x=>x&&
          accountIdPattern.test(x.id??"")&&typeof x.name==="string").slice(0,100);
        reply(res,200,{accounts:rows.map(x=>({id:x.id,name:x.name}))});return;
      }
      if(req.method==="GET"&&url.pathname==="/api/status"){
        reply(res,200,{...state,logs:[...state.logs]});return;
      }
      if(req.method==="POST"&&url.pathname==="/api/plan"){
        const input=await parseJson(req);
        const plan=validateWebInstall(input);
        reply(res,200,{plan});return;
      }
      if(req.method==="POST"&&url.pathname==="/api/install"){
        if(state.running){reply(res,409,{error:"installation_running"});return;}
        const input=await parseJson(req);
        if(input?.confirmation!=="INSTALL"){reply(res,400,{error:"explicit_confirmation_required"});return;}
        if(!accountsFromEnvironment(env)||!(env.FLIGHTDECK_CATALOG_TOKEN?.length>=20)){
          reply(res,412,{error:"installer_tokens_required",
            message:"Local web setup requires scoped CLOUDFLARE_API_TOKEN and FLIGHTDECK_CATALOG_TOKEN. Use the interactive CLI wizard as the credential-free alternative."});
          return;
        }
        const plan=validateWebInstall(input);
        const allowed=await listAccounts();
        if(!allowed.some(a=>a.id===plan.accountId)){
          reply(res,403,{error:"account_not_authorized"});return;
        }
        const selected=plan.options;
        const args=[
          "scripts/install-cloudflare.mjs","--account-id",selected.accountId,
          "--slug",selected.slug,"--admin-emails",selected.adminEmails,
          "--mode",selected.mode,"--query-units",String(selected.queryUnits),
          ...(selected.enableAI?["--enable-ai"]:[]),
          ...(!selected.enableMcp?["--skip-mcp"]:[]),
          "--apply","--yes"
        ];
        state.running=true;state.done=false;state.success=false;state.error=null;
        state.logs=[];state.startedAt=new Date().toISOString();state.finishedAt=null;
        state.options={accountId:selected.accountId,slug:selected.slug,mode:selected.mode};
        log("Starting account-owned Flightdeck installation");
        child=processLauncher(process.execPath,args,{
          cwd:projectRoot,env:{...env},stdio:["ignore","pipe","pipe"],shell:false
        });
        child.stdout?.on("data",chunk=>log(chunk.toString()));
        child.stderr?.on("data",chunk=>log(chunk.toString()));
        child.on("error",error=>{
          state.running=false;state.done=true;state.success=false;
          state.error=clean(error.message).slice(0,300);
          state.finishedAt=new Date().toISOString();log("Install failed");
        });
        child.on("close",code=>{
          state.running=false;state.done=true;state.success=code===0;
          state.finishedAt=new Date().toISOString();
          if(code!==0)state.error="Installation returned exit "+code+"; rerun with the same name after resolving the error.";
          log(code===0?"Installation command completed":"Installation failed; consult the logs");
          child=null;
        });
        reply(res,202,{started:true,plan:plan.resources});return;
      }
      reply(res,404,{error:"not_found"});
    }catch(error){
      const message=clean((error instanceof Error?error.message:String(error))).slice(0,400);
      reply(res,message==="request_too_large"?413:400,{error:message});
    }
  });
  return {server,secret,status:()=>({...state,logs:[...state.logs]})};
}
function parsePort(){
  const i=process.argv.indexOf("--port");
  const value=i===-1?portDefault:Number(process.argv[i+1]);
  if(!Number.isInteger(value)||value<1024||value>65535)throw new Error("Invalid --port");
  return value;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const port=parsePort();
  const {server}=createInstallerServer({port});
  server.listen(port,"127.0.0.1",()=>{
    console.log("\nFlightdeck local installation wizard");
    console.log("Open http://127.0.0.1:"+port);
    console.log("Credentials stay in this local process. Press Ctrl+C to stop.\n");
  });
}

/**
 * Reusable installation primitives for the account-owned wizard.
 * No Cloudflare operations are performed at import time.
 */
import {spawnSync} from "node:child_process";
import {mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, chmodSync} from "node:fs";
import {dirname,resolve} from "node:path";
import {randomBytes} from "node:crypto";

export const accountIdPattern=/^[a-fA-F0-9]{32}$/;
export const slugPattern=/^[a-z][a-z0-9-]{2,31}$/;
export const emailPattern=/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;
export const resourcePattern=/^[a-zA-Z0-9_-]{3,128}$/;
export const idPattern=/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

export function normalizeList(value) {
  if(Array.isArray(value))return value;
  if(!value||typeof value!=="object")return [];
  for(const candidate of [value.result,value.items,value.accounts,value.databases,value.buckets,
    value.result?.items,value.result?.accounts,value.result?.databases,value.result?.buckets,
    value.result?.results]){
    if(Array.isArray(candidate))return candidate;
  }
  return [];
}
export function mustIdentifier(value,pattern,label) {
  if(typeof value!=="string"||!pattern.test(value))throw new Error("Invalid "+label);
  return value;
}
export function workerHost(output) {
  const match=String(output).match(/https:\/\/([a-z0-9-]+\.[a-z0-9-]+\.workers\.dev)\/?/i);
  return match?.[1]??null;
}
export function bytes(value){return new TextEncoder().encode(String(value)).byteLength;}
export class InstallerError extends Error {
  constructor(code,message=code){super(message);this.code=code;this.name="InstallerError";}
}
export class Shell {
  constructor({cwd=process.cwd(),env=process.env,secretValues=[]}={}) {
    this.cwd=cwd;this.env={...env};this.secretValues=secretValues;
    this.log=()=>{};
  }
  redact(output){
    let s=String(output);
    for(const secret of this.secretValues)if(secret&&secret.length>=8)s=s.replaceAll(secret,"[redacted]");
    return s;
  }
  exec(command,args=[],{input,allowFailure=false,echo=false}={}){
    if(!Array.isArray(args)||args.some(x=>typeof x!=="string"))throw new Error("Invalid CLI arguments");
    const r=spawnSync(command,args,{
      cwd:this.cwd,env:this.env,encoding:"utf8",
      ...(input!==undefined?{input}:{}),
      maxBuffer:8_000_000,
      // No shell interpolation. Secrets are only passed through stdin or API request bodies.
    });
    const stdout=r.stdout??"",stderr=r.stderr??"";
    if(echo&&stdout)this.log(this.redact(stdout));
    if(r.error)throw new InstallerError("command_unavailable",command+" unavailable: "+r.error.message);
    if(r.status!==0&&!allowFailure)throw new InstallerError("command_failed",
      command+" "+args.filter(x=>!x.toLowerCase().includes("token")).join(" ")+
      " failed: "+this.redact(stderr||stdout).slice(0,1200));
    return {ok:r.status===0,stdout,stderr,status:r.status};
  }
  interactive(command,args=[]){
    const r=spawnSync(command,args,{cwd:this.cwd,env:this.env,stdio:"inherit",shell:false});
    if(r.error)throw new InstallerError("command_unavailable",command+" unavailable: "+r.error.message);
    if(r.status!==0)throw new InstallerError("command_failed",
      "Interactive CLI step failed: "+command+" "+args.join(" "));
  }
  wrangler(args,options){return this.exec("pnpm",["exec","wrangler",...args],options);}
  cf(args,options){return this.exec("cf",args,options);}
  wranglerJSON(args){
    const r=this.wrangler(args);
    try{return JSON.parse(r.stdout);}catch{throw new InstallerError("unexpected_wrangler_output",
      "Wrangler returned non-JSON output for "+args.join(" "));}
  }
  cfJSON(args){
    const r=this.cf(args);
    try{return JSON.parse(r.stdout);}catch{throw new InstallerError("unexpected_cf_output",
      "Cloudflare CLI returned non-JSON output for "+args.join(" "));}
  }
}
export class Manifest {
  constructor(path=".flightdeck/install.json"){
    this.path=resolve(path);this.state=existsSync(this.path)?JSON.parse(readFileSync(this.path,"utf8")):{
      schemaVersion:1,resources:{},steps:{},createdAt:new Date().toISOString()
    };
  }
  assertIdentity(accountId,slug){
    if(this.state.accountId&&this.state.accountId!==accountId)
      throw new InstallerError("account_mismatch","Existing Flightdeck installation belongs to another account.");
    if(this.state.slug&&this.state.slug!==slug)
      throw new InstallerError("name_mismatch","Existing Flightdeck installation uses another deployment name.");
    this.state.accountId=accountId;this.state.slug=slug;
    this.save();
  }
  save(){
    mkdirSync(dirname(this.path),{recursive:true,mode:0o700});
    const temp=this.path+"."+randomBytes(4).toString("hex")+".tmp";
    writeFileSync(temp,JSON.stringify(this.state,null,2)+"\n",{mode:0o600});
    chmodSync(temp,0o600);
    renameSync(temp,this.path);
    chmodSync(this.path,0o600);
  }
  mark(step,resources={}){
    this.state.steps[step]={status:"complete",at:new Date().toISOString()};
    Object.assign(this.state.resources,resources);
    this.save();
  }
  has(step){return this.state.steps[step]?.status==="complete";}
  get resources(){return this.state.resources;}
}
export function guardedConfig(path,data){
  const target=resolve(path);
  mkdirSync(dirname(target),{recursive:true,mode:0o700});
  writeFileSync(target,JSON.stringify(data,null,2)+"\n",{mode:0o600});
  chmodSync(target,0o600);
}
export function resourceNames(slug) {
  mustIdentifier(slug,slugPattern,"deployment slug");
  const base="flightdeck-"+slug;
  return {
    core:base+"-core",console:base+"-console",journey:base+"-journey",
    mcp:base+"-mcp",database:base+"-meta",bucket:base+"-events",
    stream:"flightdeck_"+slug.replaceAll("-","_")+"_stream",
    sink:"flightdeck_"+slug.replaceAll("-","_")+"_sink",
    pipeline:"flightdeck_"+slug.replaceAll("-","_")+"_pipeline",
    table:"flightdeck_"+slug.replaceAll("-","_")+"_events",
    queue:base+"-journeys",dlq:base+"-journeys-dlq",
    source:slug+"-app",access:"Flightdeck "+slug+" administrators",
  };
}
export function validateInstallOptions(input) {
  const accountId=mustIdentifier(input.accountId,accountIdPattern,"Cloudflare account ID");
  const slug=mustIdentifier(input.slug,slugPattern,"deployment name");
  const emails=String(input.adminEmails??"").split(",").map(x=>x.trim().toLowerCase()).filter(Boolean);
  if(!emails.length||emails.length>20||emails.some(x=>!emailPattern.test(x)))
    throw new Error("An email allowlist (1–20 addresses) is required");
  const mode=input.mode??"standard";
  if(!["standard","intelligence"].includes(mode))throw new Error("Invalid installation mode");
  return {accountId,slug,adminEmails:[...new Set(emails)],mode,names:resourceNames(slug)};
}

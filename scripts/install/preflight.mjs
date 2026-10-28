/**
 * Read-only Cloudflare capability probe before any resource mutations.
 *
 * A successful probe validates API/CLI visibility and minimum permission
 * scopes. It does NOT prove that Workers Paid, quota, billing, or the
 * selected region support the requested deployment.
 */
import {InstallerError} from "./engine.mjs";

const checked=[
  {id:"d1",api:"/d1/database",wrangler:["d1","list","--json"]},
  {id:"r2",api:"/r2/buckets",wrangler:["r2","bucket","list"]},
  {id:"basin",api:"/pipelines/v1/streams",wrangler:["basin","pipelines","streams","list"]},
];
export class PreflightError extends InstallerError {
  constructor(service,detail){
    super("account_preflight_failed",
      "Cloudflare "+service+" preflight failed: "+detail+
      ". Check account entitlement and the scoped token/CLI permissions.");
    this.service=service;
  }
}
function probeApi(accountId,path,api){
  return api.call("/accounts/"+accountId+path);
}
async function probeCLI(shell,args,label){
  const result=shell.wrangler(args,{allowFailure:true});
  if(!result.ok)throw new PreflightError(label,
    "wrangler "+args.join(" ")+" could not list resources");
  return true;
}
export async function preflightAccount({api,shell,accountId,mode="standard"}){
  if(!/^[a-f0-9]{32}$/i.test(accountId))throw new PreflightError("account","invalid account ID");
  const serviceResults=[];
  for(const check of checked){
    try{
      if(api?.enabled)await probeApi(accountId,check.api,api);
      else await probeCLI(shell,check.wrangler,check.id);
    }catch(error){
      if(error instanceof PreflightError)throw error;
      throw new PreflightError(check.id,
        error?.code==="provider_request_failed"?
          "API rejected a read-only request ("+error.message.split(";")[0].slice(0,100)+")":
          "resource capability unavailable");
    }
    serviceResults.push({service:check.id,readable:true});
  }
  // Read-only account-global Workers subdomain probe. 404 is legitimate for
  // a new Cloudflare account and handled later by ensureWorkersSubdomain.
  if(api?.enabled){
    try{await probeApi(accountId,"/workers/subdomain",api);}
    catch(e){
      if(e?.code!=="provider_request_failed"||!/\(404\)/.test(e.message))
        throw new PreflightError("workers","Workers account settings not readable");
    }
    // A missing organization can be created later; forbidden metadata cannot.
    try{await probeApi(accountId,"/access/organizations",api);}
    catch(e){
      if(e?.code!=="provider_request_failed"||!/\(404\)/.test(e.message))
        throw new PreflightError("access","Access organization settings not readable");
    }
  }
  if(mode==="intelligence"){
    try{
      if(api?.enabled)await probeApi(accountId,"/queues",api);
      else await probeCLI(shell,["queues","list"],"queues");
    }catch(e){
      if(e instanceof PreflightError)throw e;
      throw new PreflightError("queues","Queues not available or not permitted");
    }
    serviceResults.push({service:"queues",readable:true});
  }
  return {
    accountId,mode,checks:serviceResults,verifiedAt:new Date().toISOString(),
    limitations:[
      "Workers Paid/billing agreement and usable resource quotas are not guaranteed by read-only probes.",
      "Basin Catalog/Iceberg delivery and Access authentication require live end-to-end validation."
    ]
  };
}

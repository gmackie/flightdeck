/**
 * Provider operations. All mutations are scoped to one selected Cloudflare
 * account. The optional CLOUDFLARE_API_TOKEN is never written to the manifest.
 */
import {normalizeList,InstallerError,accountIdPattern} from "./engine.mjs";

export class CloudflareApi {
  constructor({accountId,token=process.env.CLOUDFLARE_API_TOKEN,fetcher=fetch}) {
    this.accountId=accountId;this.token=token;this.fetcher=fetcher;
  }
  get enabled(){return typeof this.token==="string"&&this.token.length>=20;}
  async call(path,{method="GET",body}={}){
    if(!this.enabled)throw new InstallerError("api_token_required",
      "Full unattended provisioning needs CLOUDFLARE_API_TOKEN.");
    if(!path.startsWith("/"))throw new Error("Invalid API path");
    const response=await this.fetcher("https://api.cloudflare.com/client/v4"+path,{
      method,headers:{"Authorization":"Bearer "+this.token,"Content-Type":"application/json"},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),
      signal:AbortSignal.timeout(20_000),
    });
    let payload;
    try{payload=await response.json();}catch{
      throw new InstallerError("provider_response_invalid","Cloudflare API returned invalid JSON.");
    }
    if(!response.ok||payload?.success===false){
      const errors=Array.isArray(payload?.errors)?payload.errors:[];
      const detail=errors.map(x=>x.code??"unknown").join(", ");
      throw new InstallerError("provider_request_failed",
        "Cloudflare API request failed ("+response.status+") "+method+" "+path+
        (detail?"; codes: "+detail:""));
    }
    return payload?.result??payload;
  }
  account(path){return "/accounts/"+this.accountId+path;}
}
export function validAccountList(value) {
  const accounts=normalizeList(value).filter(x=>x&&accountIdPattern.test(x.id??"")&&
    typeof x.name==="string");
  if(!accounts.length)throw new InstallerError("no_cloudflare_accounts",
    "The connected CLI/token cannot see any Cloudflare accounts.");
  return accounts;
}
export async function chooseAccount({shell,api,ask,preferred}){
  let accounts;
  if(api?.enabled){
    accounts=validAccountList(await api.call("/accounts"));
  }else{
    accounts=validAccountList(shell.cfJSON(["accounts","list"]));
  }
  const selected=accounts.find(x=>x.id===preferred);
  if(preferred&&!selected)throw new InstallerError("account_not_accessible",
    "The selected account is not accessible with these credentials.");
  if(selected)return selected;
  if(accounts.length===1)return accounts[0];
  if(!ask)throw new InstallerError("account_selection_required",
    "Multiple Cloudflare accounts available; choose --account-id.");
  accounts.forEach((a,i)=>shell.log("  "+(i+1)+". "+a.name+" ("+a.id+")"));
  const number=Number(await ask("Cloudflare account number", "1"));
  const account=accounts[number-1];
  if(!account)throw new InstallerError("invalid_account_choice");
  return account;
}
async function cfCall(shell,args,body){
  const command=body===undefined?args:[...args,"--body",JSON.stringify(body)];
  return shell.cfJSON(command);
}
async function cfMaybe(shell,args){
  const res=shell.cf(args,{allowFailure:true});
  if(!res.ok){
    if(/\b404\b|not.?found|does not exist/i.test(res.stderr+" "+res.stdout))return null;
    throw new InstallerError("cf_query_failed",
      "Cloudflare CLI query failed: "+args.slice(0,5).join(" ")+". Check permissions.");
  }
  try{return JSON.parse(res.stdout);}catch{
    throw new InstallerError("unexpected_cf_response",
      "Cloudflare CLI did not return expected JSON for "+args.slice(0,4).join(" "));
  }
}
const from=(value)=>value?.result??value;
function findNamed(value,name){return normalizeList(value).find(x=>x.name===name)||null;}
function ensureId(value,label){
  const v=from(value);
  if(!v||typeof v.id!=="string"||v.id.length<5)
    throw new InstallerError("invalid_provider_result",label+" did not return an ID.");
  return v;
}
function appHosts(app){
  return (app?.destinations??[]).filter(d=>d?.type==="public").map(d=>String(d.uri).toLowerCase());
}
function verifyDestinations(app,hosts){
  const returned=appHosts(app);
  if(hosts.some(h=>!returned.includes(h.toLowerCase())))
    throw new InstallerError("access_destination_mismatch",
      "Existing Access application is configured for different hostnames. No policies were changed.");
}
export async function ensureAccess({
  shell,api,accountId,slug,adminEmails,hosts,manifest
}){
  const own=api?.enabled;
  const path=(suffix)=>"/accounts/"+accountId+suffix;
  const get=async(suffix,cfArgs)=>own?api.call(path(suffix)):cfCall(shell,cfArgs);
  const create=async(suffix,cfArgs,body)=>own?
    api.call(path(suffix),{method:"POST",body}):cfCall(shell,cfArgs,body);
  let org;
  if(own){
    try{org=from(await get("/access/organizations",[]));}
    catch(e){
      if(e.code!=="provider_request_failed"||!/\(404\)/.test(e.message))throw e;
      org=null;
    }
  }else org=await cfMaybe(shell,["zero-trust","organization","get"]);
  org=from(org);
  if(!org?.auth_domain){
    const candidate=("flightdeck-"+accountId.slice(0,10)).toLowerCase();
    const body={name:candidate,auth_domain:candidate+".cloudflareaccess.com"};
    org=from(await create("/access/organizations",
      ["zero-trust","organization","create"],body));
  }
  if(!org?.auth_domain||!/^[-a-z0-9]+\.cloudflareaccess\.com$/.test(org.auth_domain))
    throw new InstallerError("zero_trust_not_ready",
      "Zero Trust organization is not configured; finish account onboarding in Cloudflare and rerun.");
  // Don't interfere with existing Identity Providers. Only create OTP when none exist.
  const idps=await get("/access/identity_providers",
    ["zero-trust","identity-providers","list"]);
  if(normalizeList(idps).length===0){
    await create("/access/identity_providers",
      ["zero-trust","identity-providers","create"],
      {name:"Flightdeck One-time PIN",type:"onetimepin",config:{}});
  }
  const policyName="Flightdeck "+slug+": administrators";
  const policies=await get("/access/policies",
    ["zero-trust","access","policies","list"]);
  let policy=findNamed(policies,policyName);
  if(!policy){
    policy=ensureId(await create("/access/policies",
      ["zero-trust","access","policies","create"],
      {name:policyName,decision:"allow",
        include:adminEmails.map(email=>({email:{email}})),
        session_duration:"24h"}),"Access policy");
    manifest?.mark("access_policy_created",{accessPolicyId:policy.id});
  }else if(manifest?.resources?.accessPolicyId&&manifest.resources.accessPolicyId!==policy.id){
    throw new InstallerError("access_policy_changed",
      "The recorded Access policy was replaced or changed.");
  }
  // Any existing policy with this name requires explicit reuse by id.
  if(!manifest?.resources?.accessPolicyId&&findNamed(policies,policyName)){
    throw new InstallerError("unowned_access_policy",
      "An Access policy already uses this name. Specify a different installation name or recover its manifest.");
  }
  const appName="Flightdeck "+slug+": Console and MCP";
  const apps=await get("/access/apps",
    ["zero-trust","access","applications","list"]);
  let app=findNamed(apps,appName);
  const body={
    type:"self_hosted",name:appName,
    destinations:hosts.map(uri=>({type:"public",uri})),
    policies:[{id:policy.id}],
    session_duration:"24h",app_launcher_visible:true,
  };
  if(app){
    if(manifest?.resources?.accessAppId!==app.id)
      throw new InstallerError("unowned_access_application",
        "An Access application with this name already exists and is not tracked in this installation.");
    verifyDestinations(app,hosts);
    if(!app.aud) {
      app=from(await get("/access/apps/"+app.id,
        ["zero-trust","access","applications","get",app.id]));
    }
  }else{
    app=ensureId(await create("/access/apps",
      ["zero-trust","access","applications","create"],body),"Access application");
    manifest?.mark("access_app_created",{accessAppId:app.id});
  }
  if(!app.aud||typeof app.aud!=="string")
    throw new InstallerError("access_aud_missing",
      "Cloudflare Access did not return an application AUD; keep Workers locked.");
  return {
    teamDomain:org.auth_domain,aud:app.aud,appId:app.id,policyId:policy.id,
    hosts:[...hosts]
  };
}

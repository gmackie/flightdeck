#!/usr/bin/env node
import {existsSync,readFileSync,writeFileSync,chmodSync} from "node:fs";
import {randomBytes,createHash} from "node:crypto";
const id=process.argv[2],projectId=process.argv[3]??"default";
if(!id||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) {
  console.error("Usage: pnpm source:add -- <SOURCE_ID> [PROJECT_ID]");process.exit(1);
}
const folder=".flightdeck/";
if(!existsSync(folder+"sources.json")){console.error("Run pnpm setup first");process.exit(1);}
const sources=JSON.parse(readFileSync(folder+"sources.json","utf8"));
const tokens=JSON.parse(readFileSync(folder+"source-tokens.json","utf8"));
if(sources[id]){console.error("Source already exists; use explicit rotation rather than overwriting.");process.exit(1);}
const token=randomBytes(32).toString("base64url");
sources[id]={sha256:createHash("sha256").update(token).digest("hex"),projectId,
  allowedEvents:["page.viewed","rum.*"],allowedProperties:{"page.viewed":["route"],"rum.*":["value","rating","metricId"]}};
tokens[id]=token;
writeFileSync(folder+"sources.json",JSON.stringify(sources,null,2)+"\n",{mode:0o600});
writeFileSync(folder+"source-tokens.json",JSON.stringify(tokens,null,2)+"\n",{mode:0o600});
chmodSync(folder+"sources.json",0o600);chmodSync(folder+"source-tokens.json",0o600);
console.log("Source created:",id,"Project:",projectId);
console.log("Secret (keep server-side):",token);
console.log("Redeploy the registry via: pnpm exec wrangler secret put SOURCE_CREDENTIALS --config apps/core/wrangler.generated.jsonc");

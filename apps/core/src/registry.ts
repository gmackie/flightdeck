import {type SourceConfig,IngestError} from "./ingest";

/**
 * New deployments resolve an explicitly registered source from D1. There is
 * never a default project/source on missing metadata.
 */
export interface SourceRegistryEnv {
  SOURCE_REGISTRY_MODE?:string;
  SOURCE_CREDENTIALS?:string;
  META?:D1Database;
}
type SourceRow={
  id:string;project_id:string;enabled:number;token_sha256:string|null;
  rotating_sha256_json:string;policy_json:string;version:number;
};
function fromRow(row:SourceRow):SourceConfig {
  if(row.enabled!==1||!row.token_sha256||!/^[0-9a-f]{64}$/.test(row.token_sha256))
    throw new IngestError("unauthorized_source");
  let policy:unknown,rotating:unknown;
  try{
    policy=JSON.parse(row.policy_json);rotating=JSON.parse(row.rotating_sha256_json);
  }catch{throw new IngestError("source_configuration_invalid");}
  if(!policy||typeof policy!=="object"||Array.isArray(policy)||
    !Array.isArray(rotating)||rotating.length>2||
    !rotating.every(h=>typeof h==="string"&&/^[0-9a-f]{64}$/.test(h)))
    throw new IngestError("source_configuration_invalid");
  const p=policy as Record<string,unknown>;
  if(!Array.isArray(p.allowedEvents)||
     !p.allowedEvents.every(x=>typeof x==="string")||
     !p.allowedProperties||typeof p.allowedProperties!=="object"||
     Array.isArray(p.allowedProperties))
    throw new IngestError("source_policy_missing");
  return {
    ...(p as unknown as SourceConfig),
    sha256:row.token_sha256,
    rotatingSha256:rotating as string[],
    enabled:true,
    projectId:row.project_id,
  };
}
export async function sourceRegistry(
  env:SourceRegistryEnv,sourceId:string
):Promise<Record<string,SourceConfig>> {
  if(!sourceId||! /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(sourceId))
    throw new IngestError("unauthorized_source");
  const mode=env.SOURCE_REGISTRY_MODE??"secret";
  if(mode==="d1"){
    if(!env.META)throw new IngestError("metadata_not_configured");
    const row=await env.META.prepare(
      "SELECT id,project_id,enabled,token_sha256,rotating_sha256_json,policy_json,version FROM sources WHERE id=? LIMIT 1"
    ).bind(sourceId).first<SourceRow>();
    if(!row)throw new IngestError("unauthorized_source");
    return {[sourceId]:fromRow(row)};
  }
  if(mode!=="secret"||!env.SOURCE_CREDENTIALS)
    throw new IngestError("source_configuration_missing");
  let parsed:unknown;
  try{parsed=JSON.parse(env.SOURCE_CREDENTIALS);}catch{
    throw new IngestError("source_configuration_missing");
  }
  if(!parsed||typeof parsed!=="object"||Array.isArray(parsed)||
    !Object.prototype.hasOwnProperty.call(parsed,sourceId))
    throw new IngestError("unauthorized_source");
  return {[sourceId]:(parsed as Record<string,SourceConfig>)[sourceId]!};
}

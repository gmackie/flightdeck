import {IngestError,type SourceConfig} from "./ingest";

export async function resolveSources(
  sourceId:string, db:D1Database|undefined, registry:string
):Promise<Record<string,SourceConfig>>{
  if(db){
    const record=await db.prepare(
      "SELECT project_id,token_sha256,previous_sha256,policy_json,enabled FROM source_credentials WHERE source_id=? LIMIT 2"
    ).bind(sourceId).all<{
      project_id:string;token_sha256:string;previous_sha256:string|null;
      policy_json:string;enabled:number
    }>();
    if(record.results.length>1)throw new IngestError("ambiguous_source_id");
    const row=record.results[0];
    if(row){
      const policy=JSON.parse(row.policy_json) as Partial<SourceConfig>;
      return {[sourceId]:{
        ...policy,projectId:row.project_id,sha256:row.token_sha256,
        rotatingSha256:row.previous_sha256?[row.previous_sha256]:[],
        enabled:row.enabled===1,
        allowedEvents:policy.allowedEvents??[],
        allowedProperties:policy.allowedProperties??{}
      }};
    }
  }
  return readSources(registry);
}

function readSources(serialized: string): Record<string,SourceConfig> {
  try{
    const value:unknown=JSON.parse(serialized);
    if(!value||typeof value!=="object"||Array.isArray(value))throw new Error();
    return value as Record<string,SourceConfig>;
  }catch{throw new IngestError("source_configuration_missing");}
}

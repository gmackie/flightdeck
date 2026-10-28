import {validateGraph,type GraphManifest,type GraphReceipt} from "@flightdeck/knowledge";
import type {CaptureContext} from "@flightdeck/contracts";
import {authenticate,type SourceConfig} from "./ingest";

export type GraphSubmission={context:CaptureContext;manifest:GraphManifest};
/**
 * A complete revision replaces the active projection for one authenticated
 * source, with all writes in a single D1 batch transaction.
 */
export async function registerGraph(
  input:GraphSubmission, sources:Record<string,SourceConfig>, db:D1Database
):Promise<GraphReceipt>{
  const source=await authenticate(input.context,sources);
  if(source.graphEnabled!==true)throw new Error("graph_ingestion_disabled");
  const manifest=validateGraph(input.manifest);
  const project=source.projectId,sourceId=input.context.sourceId,rev=manifest.revision;
  const statements:D1PreparedStatement[]=[
    db.prepare("UPDATE graph_nodes SET active=0 WHERE project_id=? AND source_id=?")
      .bind(project,sourceId),
    db.prepare("UPDATE graph_edges SET active=0 WHERE project_id=? AND source_id=?")
      .bind(project,sourceId),
  ];
  for(const n of manifest.nodes){
    statements.push(db.prepare(
      "INSERT INTO graph_nodes(project_id,source_id,node_id,kind,label,attributes_json,revision,active) VALUES(?,?,?,?,?,?,?,1) ON CONFLICT(project_id,source_id,node_id) DO UPDATE SET kind=excluded.kind,label=excluded.label,attributes_json=excluded.attributes_json,revision=excluded.revision,active=1,updated_at=datetime('now')"
    ).bind(project,sourceId,n.id,n.kind,n.label,JSON.stringify(n.attributes??{}),rev));
  }
  for(const e of manifest.edges){
    statements.push(db.prepare(
      "INSERT INTO graph_edges(project_id,source_id,from_id,to_id,relation,provenance,confidence,evidence_json,revision,active) VALUES(?,?,?,?,?,?,?,?,?,1) ON CONFLICT(project_id,source_id,from_id,to_id,relation) DO UPDATE SET provenance=excluded.provenance,confidence=excluded.confidence,evidence_json=excluded.evidence_json,revision=excluded.revision,active=1,updated_at=datetime('now')"
    ).bind(project,sourceId,e.from,e.to,e.relation,e.provenance,e.confidence??1,
      JSON.stringify(e.evidenceIds??[]),rev));
  }
  statements.push(db.prepare(
    "INSERT INTO audit_log(id,project_id,principal,action,resource_id,details_json) VALUES(?,?,?,?,?,?)"
  ).bind(crypto.randomUUID(),project,"source:"+sourceId,"graph.registered",sourceId,
    JSON.stringify({revision:rev,nodes:manifest.nodes.length,edges:manifest.edges.length})));
  await db.batch(statements);
  return {projectId:project,sourceId,revision:rev,nodes:manifest.nodes.length,
    edges:manifest.edges.length,durability:"d1_persisted"};
}

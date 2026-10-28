/** Read-only project-scoped access to source-authored architecture manifests. */
export interface GraphEnv {META?:D1Database;PROJECT_ID:string;}
const json=(body:unknown,status=200)=>Response.json(body,{
  status,headers:{"Cache-Control":"no-store"}
});
type NodeRow={source_id:string;node_id:string;kind:string;label:string;attributes_json:string;revision:string};
type EdgeRow={source_id:string;from_id:string;to_id:string;relation:string;provenance:string;confidence:number;evidence_json:string};
export async function handleGraph(request:Request,env:GraphEnv):Promise<Response|null>{
  const url=new URL(request.url);
  if(url.pathname!=="/api/graph")return null;
  if(request.method!=="GET")return json({error:"method_not_allowed"},405);
  if(!env.META)return json({error:"metadata_not_configured"},503);
  const nodes=await env.META.prepare(
    "SELECT source_id,node_id,kind,label,attributes_json,revision FROM graph_nodes WHERE project_id=? AND active=1 ORDER BY kind,label LIMIT 200"
  ).bind(env.PROJECT_ID).all<NodeRow>();
  const edges=await env.META.prepare(
    "SELECT source_id,from_id,to_id,relation,provenance,confidence,evidence_json FROM graph_edges WHERE project_id=? AND active=1 ORDER BY relation LIMIT 500"
  ).bind(env.PROJECT_ID).all<EdgeRow>();
  return json({
    projectId:env.PROJECT_ID,
    nodes:nodes.results.map(n=>({
      id:n.source_id+":"+n.node_id,sourceId:n.source_id,nodeId:n.node_id,
      kind:n.kind,label:n.label,attributes:JSON.parse(n.attributes_json),revision:n.revision
    })),
    edges:edges.results.map(e=>({
      from:e.source_id+":"+e.from_id,to:e.source_id+":"+e.to_id,
      relation:e.relation,provenance:e.provenance,confidence:e.confidence,
      evidence:JSON.parse(e.evidence_json),
    })),
    partial:nodes.results.length===200||edges.results.length===500
  });
}

/**
 * Versioned application-structure manifests. These describe architecture,
 * not user-specific events or private content.
 */
export type NodeKind =
  "route" | "component" | "api" | "worker" | "durable_object" |
  "database" | "object" | "journey" | "flag" | "agent" | "repo" |
  "commit" | "pr" | "deployment" | "metric" | "goal" | "external_service";
export type EdgeRelation =
  "calls" | "renders" | "emits" | "mutates" | "depends_on" |
  "deployed_by" | "modifies" | "correlated_with" | "describes" |
  "observes" | "exposes";
export type NodeProperty = string | number | boolean;
export interface GraphNode {
  id:string;kind:NodeKind;label:string;
  attributes?:Record<string,NodeProperty>;
}
export interface GraphEdge {
  from:string;to:string;relation:EdgeRelation;
  provenance:"source_code"|"runtime"|"inference";
  confidence?:number;
  evidenceIds?:string[];
}
export interface GraphManifest {
  revision:string;
  nodes:GraphNode[];
  edges:GraphEdge[];
}
export interface GraphReceipt {
  projectId:string;sourceId:string;revision:string;
  nodes:number;edges:number;durability:"d1_persisted";
}
const nodeKinds=new Set<NodeKind>([
  "route","component","api","worker","durable_object","database","object","journey","flag",
  "agent","repo","commit","pr","deployment","metric","goal","external_service"
]);
const relations=new Set<EdgeRelation>([
  "calls","renders","emits","mutates","depends_on","deployed_by","modifies",
  "correlated_with","describes","observes","exposes"
]);
const provenance=new Set(["source_code","runtime","inference"]);
const idPattern=/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const blockedKeys=/^(password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|token|cookie|authorization|email|phone|ssn|card[_-]?number)$/i;
export class GraphError extends Error {
  constructor(readonly code:string){super(code);this.name="GraphError";}
}
export function validateGraph(input:unknown):GraphManifest {
  if(!input||typeof input!=="object"||Array.isArray(input))throw new GraphError("invalid_manifest");
  const m=input as GraphManifest;
  if(!idPattern.test(m.revision)||!Array.isArray(m.nodes)||!Array.isArray(m.edges)||
    m.nodes.length<1||m.nodes.length>50||m.edges.length>120)
    throw new GraphError("invalid_manifest_size");
  const ids=new Set<string>();
  const nodes:GraphNode[]=[];
  for(const node of m.nodes){
    if(!node||typeof node.id!=="string"||!idPattern.test(node.id)||
      !nodeKinds.has(node.kind)||typeof node.label!=="string"||
      node.label.length<1||node.label.length>160)throw new GraphError("invalid_node");
    if(ids.has(node.id))throw new GraphError("duplicate_node");
    ids.add(node.id);
    const props=node.attributes??{};
    if(typeof props!=="object"||props===null||Array.isArray(props)||
      Object.keys(props).length>24)throw new GraphError("invalid_attributes");
    const attributes:Record<string,NodeProperty>={};
    for(const [key,value] of Object.entries(props)){
      if(key.length>64||blockedKeys.test(key))throw new GraphError("unsafe_attribute");
      if(typeof value!=="string"&&typeof value!=="number"&&typeof value!=="boolean")
        throw new GraphError("invalid_attribute_value");
      if(typeof value==="string"&&value.length>512)throw new GraphError("attribute_too_long");
      if(typeof value==="number"&&!Number.isFinite(value))throw new GraphError("invalid_attribute_value");
      attributes[key]=value;
    }
    nodes.push({id:node.id,kind:node.kind,label:node.label,attributes});
  }
  const edges:GraphEdge[]=[];
  const edgeIds=new Set<string>();
  for(const edge of m.edges){
    if(!edge||!ids.has(edge.from)||!ids.has(edge.to)||!relations.has(edge.relation)||
      !provenance.has(edge.provenance))throw new GraphError("invalid_edge");
    const confidence=edge.confidence??(edge.provenance==="inference"?0:1);
    if(!Number.isFinite(confidence)||confidence<0||confidence>1)throw new GraphError("invalid_confidence");
    const evidenceIds=edge.evidenceIds??[];
    if(!Array.isArray(evidenceIds)||evidenceIds.length>12||!evidenceIds.every(id=>typeof id==="string"&&idPattern.test(id)))
      throw new GraphError("invalid_edge_evidence");
    if(edge.provenance==="inference"&&!evidenceIds.length)throw new GraphError("ungrounded_inference");
    const signature=edge.from+":"+edge.to+":"+edge.relation;
    if(edgeIds.has(signature))throw new GraphError("duplicate_edge");
    edgeIds.add(signature);
    edges.push({from:edge.from,to:edge.to,relation:edge.relation,
      provenance:edge.provenance,confidence,evidenceIds:[...evidenceIds]});
  }
  return {revision:m.revision,nodes,edges};
}

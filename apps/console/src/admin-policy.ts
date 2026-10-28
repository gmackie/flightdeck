/**
 * Shared admin-plane validation. No untrusted input is used as SQL syntax,
 * deployed Worker names, or Cloudflare API resource identifiers.
 */
export type SourceKind="product"|"rum"|"error"|"exposure"|"agent";
export interface SourcePolicy {
  allowedEvents:string[];
  allowedProperties:Record<string,string[]>;
  allowedKinds:SourceKind[];
  allowedEnvironments:string[];
  consentRequired:boolean;
  graphEnabled:boolean;
  maxBatchSize:number;
  maxBatchBytes:number;
}
export type AdminOperation =
  | {kind:"source.disable";sourceId:string}
  | {kind:"source.enable";sourceId:string}
  | {kind:"source.policy";sourceId:string;policy:SourcePolicy}
  | {kind:"budget.query";units:number}
  | {kind:"budget.ai";dailyLimit:number};
const id=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const event=/^[a-z][a-z0-9_.-]{0,127}(?:\.\*)?$/;
const name=/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/;
const kinds=new Set<SourceKind>(["product","rum","error","exposure","agent"]);
const sensitive=/^(?:password|secret|access_token|api_key|authorization|cookie|cvv|card_number|ssn)$/i;
export class AdminValidationError extends Error{
  constructor(readonly code:string){super(code);this.name="AdminValidationError";}
}
export function validateSourceId(input:unknown):string {
  if(typeof input!=="string"||!id.test(input))throw new AdminValidationError("invalid_source_id");
  return input;
}
function stringArray(value:unknown,limit:number,maxLen:number,re:RegExp,label:string):string[]{
  if(!Array.isArray(value)||value.length>limit||value.some(x=>typeof x!=="string"||x.length>maxLen||!re.test(x)))
    throw new AdminValidationError(label);
  return [...new Set(value)];
}
export function validateSourcePolicy(input:unknown):SourcePolicy {
  if(!input||typeof input!=="object"||Array.isArray(input))throw new AdminValidationError("invalid_source_policy");
  const x=input as Record<string,unknown>;
  const allowedEvents=stringArray(x.allowedEvents,100,130,event,"invalid_allowed_events");
  if(!allowedEvents.length)throw new AdminValidationError("missing_allowed_events");
  const props=x.allowedProperties;
  if(!props||typeof props!=="object"||Array.isArray(props))throw new AdminValidationError("invalid_allowed_properties");
  const allowedProperties:Record<string,string[]>=Object.create(null);
  const entries=Object.entries(props);
  if(entries.length>100)throw new AdminValidationError("too_many_event_schemas");
  for(const [ev,keys] of entries){
    if(!event.test(ev)||!allowedEvents.includes(ev))
      throw new AdminValidationError("unregistered_event_schema");
    const values=stringArray(keys,60,64,name,"invalid_property_keys");
    if(values.some(key=>sensitive.test(key)))throw new AdminValidationError("sensitive_property_key");
    allowedProperties[ev]=values;
  }
  // Every event name and wildcard needs an explicit property allowance.
  for(const ev of allowedEvents)if(!Object.hasOwn(allowedProperties,ev))
    throw new AdminValidationError("missing_event_properties");
  const kindsInput=x.allowedKinds??["product","rum","exposure"];
  const allowedKinds=stringArray(kindsInput,5,30,/^[a-z]+$/,"invalid_allowed_kinds") as SourceKind[];
  if(allowedKinds.some(k=>!kinds.has(k)))throw new AdminValidationError("invalid_allowed_kinds");
  const allowedEnvironments=stringArray(
    x.allowedEnvironments??["production","staging"],10,30,name,"invalid_allowed_environments");
  if(!allowedEnvironments.length)throw new AdminValidationError("invalid_allowed_environments");
  const maxBatchSize=x.maxBatchSize??100,maxBatchBytes=x.maxBatchBytes??256000;
  if(!Number.isSafeInteger(maxBatchSize)||Number(maxBatchSize)<1||Number(maxBatchSize)>100)
    throw new AdminValidationError("invalid_max_batch_size");
  if(!Number.isSafeInteger(maxBatchBytes)||Number(maxBatchBytes)<1024||Number(maxBatchBytes)>256000)
    throw new AdminValidationError("invalid_max_batch_bytes");
  if(x.consentRequired!==undefined&&typeof x.consentRequired!=="boolean")
    throw new AdminValidationError("invalid_consent_policy");
  if(x.graphEnabled!==undefined&&typeof x.graphEnabled!=="boolean")
    throw new AdminValidationError("invalid_graph_policy");
  return {
    allowedEvents,allowedProperties,allowedKinds,allowedEnvironments,
    maxBatchSize:Number(maxBatchSize),maxBatchBytes:Number(maxBatchBytes),
    consentRequired:x.consentRequired??false,graphEnabled:x.graphEnabled??false
  };
}
export function validateAdminOperation(value:unknown):AdminOperation {
  if(!value||typeof value!=="object"||Array.isArray(value))throw new AdminValidationError("invalid_operation");
  const x=value as Record<string,unknown>;
  const kind=x.kind;
  switch(kind){
    case "source.disable":
    case "source.enable":
      return {kind,sourceId:validateSourceId(x.sourceId)};
    case "source.policy":
      return {kind,sourceId:validateSourceId(x.sourceId),policy:validateSourcePolicy(x.policy)};
    case "budget.query":
      if(!Number.isSafeInteger(x.units)||Number(x.units)<0||Number(x.units)>100_000_000)
        throw new AdminValidationError("invalid_query_budget");
      return {kind,units:Number(x.units)};
    case "budget.ai":
      if(!Number.isSafeInteger(x.dailyLimit)||Number(x.dailyLimit)<0||Number(x.dailyLimit)>100)
        throw new AdminValidationError("invalid_ai_budget");
      return {kind,dailyLimit:Number(x.dailyLimit)};
    default:throw new AdminValidationError("operation_not_allowed");
  }
}
export function defaultSourcePolicy():SourcePolicy {
  return validateSourcePolicy({
    allowedEvents:["page.viewed","rum.*","feature.exposed"],
    allowedProperties:{
      "page.viewed":["route"],"rum.*":["value","rating","metricId"],
      "feature.exposed":["flagKey","variant","experimentId"]
    },allowedKinds:["product","rum","exposure"],
    allowedEnvironments:["production","staging"],
    consentRequired:true,graphEnabled:false,maxBatchSize:100,maxBatchBytes:65536
  });
}

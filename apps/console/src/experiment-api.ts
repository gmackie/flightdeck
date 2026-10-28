import {analyzeExperiment,type ArmCounts} from "@flightdeck/experiments";
import {executeBasinQuery,type QueryRuntimeEnv} from "./query-runtime";
import type {QuerySpec} from "@flightdeck/query";

const json=(body:unknown,status=200)=>Response.json(body,{
  status,headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}
});
function rows(value:unknown):Array<Record<string,unknown>>{
  const x=value as any;
  for(const result of [x?.data?.result?.rows,x?.data?.result?.data,x?.data?.rows,
    x?.data?.data,x?.data?.result,x?.data]){
    if(Array.isArray(result))return result.filter(y=>y&&typeof y==="object").slice(0,10);
  }
  return [];
}
export async function handleExperimentAnalysis(
  req:Request,env:QueryRuntimeEnv,principal:string
):Promise<Response|null>{
  const url=new URL(req.url);
  if(url.pathname!=="/api/experiment-analyze")return null;
  if(req.method!=="POST")return json({error:"method_not_allowed"},405);
  if(req.headers.get("Origin")!==url.origin)return json({error:"origin_not_allowed"},403);
  if(Number(req.headers.get("Content-Length")??0)>4096)return json({error:"request_too_large"},413);
  const raw=await req.text();
  if(raw.length>4096)return json({error:"request_too_large"},413);
  let input:unknown;
  try{input=JSON.parse(raw);}catch{return json({error:"invalid_json"},400);}
  if(!input||typeof input!=="object")return json({error:"invalid_experiment_query"},400);
  const b=input as Record<string,unknown>;
  const days=b.days===undefined?14:Number(b.days);
  if(!Number.isInteger(days)||days<1||days>31)return json({error:"invalid_range"},400);
  const now=Date.now();
  const spec:QuerySpec={
    kind:"experiment-analysis",
    from:new Date(now-days*86_400_000).toISOString(),to:new Date(now).toISOString(),
    flagKey:typeof b.flagKey==="string"?b.flagKey:undefined,
    goalEvent:typeof b.goalEvent==="string"?b.goalEvent:undefined,
    controlVariant:typeof b.controlVariant==="string"?b.controlVariant:undefined,
    treatmentVariant:typeof b.treatmentVariant==="string"?b.treatmentVariant:undefined,
  };
  const response=await executeBasinQuery(spec,env,{principal,now});
  if(!response.ok)return response;
  const payload=await response.json();
  const summaries=rows(payload);
  const asArm=(variant:string):ArmCounts=>{
    const found=summaries.find(row=>row.variant===variant);
    return {variant,exposed:Number(found?.exposed??0),converted:Number(found?.converted??0)};
  };
  try{
    const result=analyzeExperiment(asArm(spec.controlVariant!),asArm(spec.treatmentVariant!));
    return json({analysis:result,source:"flightdeck_basin_events",flagKey:spec.flagKey,
      goalEvent:spec.goalEvent,days,randomizationProven:false});
  }catch{return json({error:"invalid_experiment_data"},502);}
}

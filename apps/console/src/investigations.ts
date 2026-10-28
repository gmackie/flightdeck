import {
  summarizeChanges,validateProposal,deterministicProposal,proposalPrompt,
  type Evidence,type InvestigationProposal
} from "@flightdeck/investigations";
import {executeBasinQuery,type QueryRuntimeEnv} from "./query-runtime";
import type {AIProvider} from "./ai";

export interface InvestigationEnv extends QueryRuntimeEnv {
  META?:D1Database; ADMIN_EMAILS?:string;
  AI?:AIProvider; AI_ENABLED?:string; AI_MODEL?:string;
  AI_INVESTIGATION_DAILY_LIMIT?:string;
}
export type InvestigationPrincipal={sub:string;email:string};
const json=(x:unknown,status=200)=>Response.json(x,{status,headers:{"Cache-Control":"no-store"}});
const authorized=(env:InvestigationEnv,p:InvestigationPrincipal)=>
  (env.ADMIN_EMAILS??"").toLowerCase().split(",").map(s=>s.trim()).includes(p.email.toLowerCase());
function mutable(req:Request,env:InvestigationEnv,p:InvestigationPrincipal){
  return authorized(env,p)&&req.headers.get("Origin")===new URL(req.url).origin;
}
async function body(req:Request):Promise<unknown>{
  if(Number(req.headers.get("Content-Length")??0)>8192)throw new Error("body_too_large");
  const raw=await req.text();
  if(raw.length>8192)throw new Error("body_too_large");
  try{return JSON.parse(raw);}catch{throw new Error("invalid_json");}
}
function eventCounts(data:unknown):Record<string,number>{
  const x=data as any;
  const arrays=[x?.data?.result?.rows,x?.data?.result?.data,x?.data?.rows,
    x?.data?.data,x?.data?.result,x?.data];
  const rows=arrays.find(Array.isArray);
  const out:Record<string,number>=Object.create(null);
  if(Array.isArray(rows))for(const row of rows.slice(0,100)){
    if(row&&typeof row.event_name==="string"&&/^[a-z][a-z0-9_.-]{0,127}$/.test(row.event_name)){
      const n=Number(row.events);
      if(Number.isSafeInteger(n)&&n>=0)out[row.event_name]=n;
    }
  }
  return out;
}
async function reserveAI(env:InvestigationEnv):Promise<boolean>{
  const limit=Number(env.AI_INVESTIGATION_DAILY_LIMIT??"3");
  if(!Number.isSafeInteger(limit)||limit<0||limit>100)return false;
  const day=new Date().toISOString().slice(0,10),db=env.META!;
  const result=await db.batch([
    db.prepare("INSERT OR IGNORE INTO ai_budgets(project_id,period,investigations_used,investigations_limit) VALUES(?,?,0,?)")
      .bind(env.PROJECT_ID,day,limit),
    db.prepare("UPDATE ai_budgets SET investigations_used=investigations_used+1 WHERE project_id=? AND period=? AND investigations_used<investigations_limit")
      .bind(env.PROJECT_ID,day),
  ]);
  return Number(result[1]?.meta?.changes??0)>0;
}
async function generate(
  question:string,evidence:Evidence[],env:InvestigationEnv
):Promise<{proposal:InvestigationProposal;model:string}>{
  if(env.AI_ENABLED!=="true"||!env.AI)
    return {proposal:deterministicProposal(evidence,question),model:"deterministic-v1"};
  const model=env.AI_MODEL??"@cf/meta/llama-3.3-70b-instruct-fp8-fast";
  const reply=await env.AI.run(model,{
    messages:[
      {role:"system",content:"Return JSON. Only evidence-grounded hypotheses. No causal claims or tool execution."},
      {role:"user",content:proposalPrompt(question,evidence)}
    ],
    max_tokens:800,
  });
  const value=(reply as {response?:unknown})?.response??reply;
  return {proposal:validateProposal(typeof value==="string"?JSON.parse(value):value,evidence),model};
}
async function investigate(
  question:string,env:InvestigationEnv,principal:InvestigationPrincipal
):Promise<{proposal:InvestigationProposal;evidence:Evidence[];model:string}>{
  const now=Date.now(),week=7*86400000;
  const windows=[
    {from:new Date(now-week).toISOString(),to:new Date(now).toISOString()},
    {from:new Date(now-2*week).toISOString(),to:new Date(now-week).toISOString()}
  ];
  const responses=await Promise.all(windows.map(range=>
    executeBasinQuery({kind:"top-events",...range,limit:100},env,{principal:principal.sub,now})));
  if(responses.some(r=>!r.ok))throw new Error("analytics_unavailable");
  const payloads=await Promise.all(responses.map(r=>r.json()));
  const evidence=summarizeChanges(eventCounts(payloads[0]),eventCounts(payloads[1]),{
    from:windows[0]!.from,to:windows[0]!.to,
    baselineFrom:windows[1]!.from,baselineTo:windows[1]!.to
  });
  if(!evidence.length)throw new Error("insufficient_evidence");
  return {...await generate(question,evidence,env),evidence};
}
export async function handleInvestigations(
  req:Request,env:InvestigationEnv,principal:InvestigationPrincipal
):Promise<Response|null>{
  const pathname=new URL(req.url).pathname,method=req.method;
  if(!pathname.startsWith("/api/investigations")&&!pathname.startsWith("/api/proposed-actions"))return null;
  if(!env.META)return json({error:"metadata_not_configured"},503);
  const db=env.META;
  try{
    if(pathname==="/api/investigations"){
      if(method==="GET"){
        const r=await db.prepare("SELECT id,title,question,status,model_id,created_by,created_at FROM investigations WHERE project_id=? ORDER BY created_at DESC LIMIT 50")
          .bind(env.PROJECT_ID).all();
        return json({items:r.results});
      }
      if(method!=="POST")return json({error:"method_not_allowed"},405);
      if(!mutable(req,env,principal))return json({error:"forbidden"},403);
      const input=await body(req) as {question?:unknown};
      if(typeof input?.question!=="string"||input.question.trim().length<3||input.question.length>500)
        return json({error:"invalid_question"},400);
      if(env.AI_ENABLED==="true"&&env.AI&&!await reserveAI(env))
        return json({error:"ai_quota_exceeded"},429);
      let result:Awaited<ReturnType<typeof investigate>>;
      try{result=await investigate(input.question,env,principal);}
      catch{return json({error:"investigation_unavailable"},503);}
      const id=crypto.randomUUID();
      const {evidence,proposal,model}=result;
      const queries:D1PreparedStatement[]=[
        db.prepare("INSERT INTO investigations(id,project_id,title,question,status,model_id,evidence_json,interpretation_json,created_by) VALUES(?,?,?,?,?,?,?,?,?)")
          .bind(id,env.PROJECT_ID,proposal.title,input.question,"proposed",model,JSON.stringify(evidence),JSON.stringify(proposal),principal.sub),
        db.prepare("INSERT INTO audit_log(id,project_id,principal,action,resource_id,details_json) VALUES(?,?,?,?,?,?)")
          .bind(crypto.randomUUID(),env.PROJECT_ID,principal.sub,"investigation.created",id,JSON.stringify({model}))
      ];
      for(const action of proposal.proposedActions)queries.push(
        db.prepare("INSERT INTO proposed_actions(id,project_id,investigation_id,action_type,summary,acceptance_json,status) VALUES(?,?,?,?,?,?,?)")
          .bind(crypto.randomUUID(),env.PROJECT_ID,id,action.kind,action.summary,JSON.stringify(action.acceptanceCriteria),"proposed")
      );
      await db.batch(queries);
      return json({id,proposal,evidence,model,status:"proposed"},201);
    }
    const investigationId=pathname.match(/^\/api\/investigations\/([0-9a-f-]{36})$/i)?.[1];
    if(investigationId&&method==="GET"){
      const row=await db.prepare("SELECT id,title,question,status,model_id,evidence_json,interpretation_json,created_at FROM investigations WHERE id=? AND project_id=?")
        .bind(investigationId,env.PROJECT_ID).first<{
          id:string;title:string;question:string;status:string;model_id:string;
          evidence_json:string;interpretation_json:string;created_at:string
        }>();
      if(!row)return json({error:"not_found"},404);
      const actions=await db.prepare("SELECT id,action_type,summary,acceptance_json,status,approval_rationale FROM proposed_actions WHERE investigation_id=? AND project_id=? LIMIT 30")
        .bind(investigationId,env.PROJECT_ID).all();
      return json({id:row.id,title:row.title,question:row.question,status:row.status,modelId:row.model_id,
        evidence:JSON.parse(row.evidence_json),proposal:JSON.parse(row.interpretation_json),
        actions:actions.results.map(x=>({...x,acceptance:JSON.parse(String(x.acceptance_json)),acceptance_json:undefined})),
        createdAt:row.created_at});
    }
    const actionId=pathname.match(/^\/api\/proposed-actions\/([0-9a-f-]{36})\/decision$/i)?.[1];
    if(actionId&&method==="POST"){
      if(!mutable(req,env,principal))return json({error:"forbidden"},403);
      const input=await body(req) as {decision?:unknown;rationale?:unknown};
      if(!["approved","rejected"].includes(String(input?.decision))||
        typeof input?.rationale!=="string"||input.rationale.trim().length<12||input.rationale.length>512)
        return json({error:"invalid_decision"},400);
      const result=await db.batch([
        db.prepare("UPDATE proposed_actions SET status=?,decided_by=?,approval_rationale=?,decided_at=datetime('now') WHERE id=? AND project_id=? AND status='proposed'")
          .bind(input.decision,principal.sub,input.rationale.trim(),actionId,env.PROJECT_ID),
        db.prepare("INSERT INTO audit_log(id,project_id,principal,action,resource_id,details_json) VALUES(?,?,?,?,?,?)")
          .bind(crypto.randomUUID(),env.PROJECT_ID,principal.sub,"proposed_action."+input.decision,actionId,
            JSON.stringify({rationale:input.rationale.trim()}))
      ]);
      return json({updated:Number(result[0]?.meta?.changes??0)>0,status:input.decision});
    }
    return json({error:"not_found"},404);
  }catch(error){
    if((error as Error).message==="body_too_large")return json({error:"body_too_large"},413);
    if((error as Error).message==="invalid_json")return json({error:"invalid_json"},400);
    console.error("investigation API failed",error);
    return json({error:"investigation_unavailable"},503);
  }
}

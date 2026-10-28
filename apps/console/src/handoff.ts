/**
 * Handoff from an administrator-approved investigation action to a single
 * account-configured GitHub Issues repository. Never executes agent code.
 *
 * External HTTP + D1 cannot be a transaction. An attempted issue creation
 * must never be retried automatically after an ambiguous network failure.
 */
export interface AgentHandoffEnv {
  META?: D1Database;
  PROJECT_ID: string;
  ADMIN_EMAILS?: string;
  GITHUB_REPOSITORY?: string;
  /** Cloudflare Worker secret with Issues: write on the one configured repo. */
  GITHUB_ISSUES_TOKEN?: string;
}
export type HandoffPrincipal = {sub:string;email:string};
type ProposedActionRow = {
  id:string;project_id:string;investigation_id:string;action_type:string;
  summary:string;acceptance_json:string;status:string;
  handoff_status:string;handoff_issue_url:string|null;
};
type HandoffResponse = {issueUrl:string;issueNumber:number;status:"created"};
type Fetcher = typeof fetch;
const json=(x:unknown,status=200)=>Response.json(x,{
  status,headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}
});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const repository=/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
function canHandoff(req:Request,env:AgentHandoffEnv,p:HandoffPrincipal):boolean{
  const allowed=(env.ADMIN_EMAILS??"").toLowerCase().split(",").map(x=>x.trim()).filter(Boolean);
  return allowed.includes(p.email.toLowerCase())&&req.headers.get("Origin")===new URL(req.url).origin;
}
async function parseConfirmation(req:Request):Promise<boolean>{
  if(Number(req.headers.get("Content-Length")??0)>4096)return false;
  const raw=await req.text();
  if(new TextEncoder().encode(raw).length>4096)return false;
  try{
    const parsed=JSON.parse(raw) as unknown;
    return !!parsed&&typeof parsed==="object"&&!Array.isArray(parsed)&&
      (parsed as {confirm?:unknown}).confirm==="CREATE_ISSUE";
  }catch{return false;}
}
function clean(value:string,max:number):string{
  // Keep issue content bounded; no direct user-submitted Markdown/HTML.
  // This is an engineering proposal, so GitHub may render markdown supplied
  // by the LLM. Treat it as untrusted content in any downstream automation.
  return value.replace(/[\u0000-\u001F\u007F]/g," ").trim().slice(0,max);
}
export function issueForAction(row:ProposedActionRow):{
  title:string;body:string
}{
  let acceptance:unknown;
  try{acceptance=JSON.parse(row.acceptance_json);}
  catch{throw new Error("invalid_acceptance");}
  if(!Array.isArray(acceptance)||acceptance.length>8||
    !acceptance.every(x=>typeof x==="string"&&x.length<=200))
    throw new Error("invalid_acceptance");
  const summary=clean(row.summary,400);
  if(!summary||!uuid.test(row.id)||!uuid.test(row.investigation_id))
    throw new Error("invalid_action");
  const kind=clean(row.action_type,50);
  const title=clean(`[Flightdeck] ${kind}: ${summary}`,140);
  const points=acceptance.map(x=>"- "+clean(x,200));
  const body=[
    "## Flightdeck engineering proposal",
    "",
    "**This is an AI-assisted review work item, not an approved code change or production instruction.**",
    "Review the evidence and the affected code before implementation.",
    "",
    "### Proposed action",
    summary,
    "",
    "### Acceptance criteria",
    ...(points.length?points:["- Needs human acceptance criteria before implementation"]),
    "",
    "### Evidence reference",
    "Flightdeck investigation: "+row.investigation_id,
    "Flightdeck action: "+row.id,
    "",
    "### Safety conditions",
    "- Do not run commands or modify production based solely on this issue.",
    "- Obtain normal repository review and CI approval.",
    "- Verify the original hypothesis against Flightdeck evidence.",
    "- Keep Flagship rollout changes within the Cloudflare dashboard.",
    "",
    "<!-- flightdeck-action:"+row.id+" -->"
  ].join("\n");
  return {title,body};
}
async function audit(
  db:D1Database,env:AgentHandoffEnv,principal:HandoffPrincipal,
  actionId:string,event:string,details:Record<string,unknown>
):Promise<void>{
  await db.prepare(
    "INSERT INTO audit_log(id,project_id,principal,action,resource_id,details_json) VALUES(?,?,?,?,?,?)"
  ).bind(crypto.randomUUID(),env.PROJECT_ID,principal.sub,event,actionId,
    JSON.stringify(details)).run();
}
/** Inject fetcher for deterministic tests; production uses global fetch. */
export async function handleAgentHandoff(
  req:Request,env:AgentHandoffEnv,principal:HandoffPrincipal,
  fetcher:Fetcher=fetch
):Promise<Response|null>{
  const url=new URL(req.url);
  const actionId=url.pathname.match(/^\/api\/proposed-actions\/([0-9a-f-]{36})\/handoff$/i)?.[1];
  if(!actionId)return null;
  if(req.method!=="POST")return json({error:"method_not_allowed"},405);
  if(!canHandoff(req,env,principal))return json({error:"forbidden"},403);
  if(!env.META)return json({error:"metadata_not_configured"},503);
  if(!repository.test(env.GITHUB_REPOSITORY??"")||
    !env.GITHUB_ISSUES_TOKEN||env.GITHUB_ISSUES_TOKEN.length<20)
    return json({error:"github_handoff_not_configured"},503);
  if(!await parseConfirmation(req))return json({error:"explicit_confirmation_required"},400);
  const db=env.META;
  try{
    const row=await db.prepare(
      "SELECT id,project_id,investigation_id,action_type,summary,acceptance_json,status,handoff_status,handoff_issue_url FROM proposed_actions WHERE id=? AND project_id=?"
    ).bind(actionId,env.PROJECT_ID).first<ProposedActionRow>();
    if(!row)return json({error:"not_found"},404);
    if(row.status!=="approved")return json({error:"action_not_approved"},409);
    if(row.handoff_status!=="not_started")
      return json({error:"handoff_already_initiated",
        status:row.handoff_status,
        ...(row.handoff_issue_url?{issueUrl:row.handoff_issue_url}:{})},409);
    let issue:{title:string;body:string};
    try{issue=issueForAction(row);}
    catch{return json({error:"invalid_action_payload"},422);}
    // Atomic compare-and-swap claim blocks concurrent duplicate GitHub issues.
    const claim=await db.prepare(
      "UPDATE proposed_actions SET handoff_status='creating',handoff_attempted_at=datetime('now') WHERE id=? AND project_id=? AND status='approved' AND handoff_status='not_started'"
    ).bind(actionId,env.PROJECT_ID).run();
    if(Number(claim.meta?.changes??0)!==1)return json({error:"handoff_already_initiated"},409);
    await audit(db,env,principal,actionId,"handoff.claimed",
      {repository:env.GITHUB_REPOSITORY});
    let issueUrl:string|undefined,issueNumber:number|undefined;
    try{
      const response=await fetcher(
        "https://api.github.com/repos/"+env.GITHUB_REPOSITORY+"/issues",
        {method:"POST",headers:{
          "Accept":"application/vnd.github+json",
          "Authorization":"Bearer "+env.GITHUB_ISSUES_TOKEN,
          "X-GitHub-Api-Version":"2026-03-10",
          "Content-Type":"application/json",
          "User-Agent":"flightdeck-self-hosted"
        },body:JSON.stringify(issue),signal:AbortSignal.timeout(15_000)}
      );
      if(response.status!==201)throw new Error("github_create_issue_failed:"+response.status);
      const created=await response.json() as {html_url?:unknown;number?:unknown};
      if(typeof created.html_url!=="string"||
        !created.html_url.startsWith("https://github.com/"+env.GITHUB_REPOSITORY+"/issues/")||
        !Number.isSafeInteger(created.number))
        throw new Error("github_response_invalid");
      issueUrl=created.html_url;issueNumber=created.number as number;
    }catch(err){
      // Do not retry; request might have succeeded despite timeout/read failure.
      try{
        await db.prepare(
          "UPDATE proposed_actions SET handoff_status='uncertain' WHERE id=? AND project_id=? AND handoff_status='creating'"
        ).bind(actionId,env.PROJECT_ID).run();
        await audit(db,env,principal,actionId,"handoff.uncertain",
          {repository:env.GITHUB_REPOSITORY,reason:String((err as Error).message).slice(0,100)});
      }catch(e){console.error("Flightdeck handoff reconciliation metadata failed",e);}
      return json({error:"github_handoff_uncertain",
        message:"Check the target repository for the Flightdeck action marker before retrying manually."},502);
    }
    try{
      await db.batch([
        db.prepare(
          "UPDATE proposed_actions SET handoff_status='created',handoff_issue_url=? WHERE id=? AND project_id=? AND handoff_status='creating'"
        ).bind(issueUrl,actionId,env.PROJECT_ID),
        db.prepare(
          "INSERT INTO audit_log(id,project_id,principal,action,resource_id,details_json) VALUES(?,?,?,?,?,?)"
        ).bind(crypto.randomUUID(),env.PROJECT_ID,principal.sub,"handoff.created",
          actionId,JSON.stringify({repository:env.GITHUB_REPOSITORY,issueUrl}))
      ]);
    }catch(err){
      // GitHub issue now exists, but D1 write failed. Never repeat this POST.
      console.error("Flightdeck issue exists but metadata update failed",err);
      return json({error:"handoff_metadata_unavailable",
        message:"Issue may exist; reconcile manually using the Flightdeck action marker."},503);
    }
    return json({issueUrl,issueNumber,status:"created"} satisfies HandoffResponse,201);
  }catch(err){
    console.error("Flightdeck handoff metadata failed",err);
    return json({error:"handoff_unavailable"},503);
  }
}

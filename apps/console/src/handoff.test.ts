import {describe,expect,it,vi} from "vitest";
import {handleAgentHandoff,issueForAction,type AgentHandoffEnv} from "./handoff";
const actionId="11111111-1111-4111-8111-111111111111";
const investigationId="22222222-2222-4222-8222-222222222222";
const admin={sub:"principal-1",email:"admin@example.com"};
const base:AgentHandoffEnv={
  PROJECT_ID:"tenant",
  ADMIN_EMAILS:"admin@example.com",
  GITHUB_REPOSITORY:"example/work-items",
  GITHUB_ISSUES_TOKEN:"a".repeat(40),
};
const row=()=>({
  id:actionId,project_id:"tenant",investigation_id:investigationId,
  action_type:"engineering_review",summary:"Investigate checkout failures",
  acceptance_json:JSON.stringify(["Reproduce issue","Add regression tests"]),
  status:"approved",handoff_status:"not_started",handoff_issue_url:null
});
function makeDb(initial=row()){
  let state={...initial};
  const prepared:string[]=[];
  const db={
    prepare:(query:string)=>{
      prepared.push(query);
      return {bind:(...args:unknown[])=>({
        first:async()=>query.startsWith("SELECT")?{...state}:null,
        run:async()=>{
          if(query.includes("SET handoff_status='creating'")&&state.handoff_status==="not_started"){
            state.handoff_status="creating";return {meta:{changes:1}};
          }
          if(query.includes("SET handoff_status='uncertain'")){
            state.handoff_status="uncertain";return {meta:{changes:1}};
          }
          return {meta:{changes:1}};
        }
      })};
    },
    batch:async(statements:unknown[])=>{
      state.handoff_status="created";
      return statements.map(()=>({meta:{changes:1}}));
    }
  } as unknown as D1Database;
  return {db,state:()=>state,prepared};
}
const makeRequest=(origin="https://analytics.example")=>new Request(
  "https://analytics.example/api/proposed-actions/"+actionId+"/handoff",{
    method:"POST",
    headers:{"Origin":origin,"Content-Type":"application/json"},
    body:JSON.stringify({confirm:"CREATE_ISSUE"})
  }
);
describe("approved investigation handoff",()=>{
  it("builds bounded proposal issues with stable marker, no execution request",()=>{
    const issue=issueForAction(row());
    expect(issue.title).toContain("Flightdeck");
    expect(issue.body).toContain("<!-- flightdeck-action:"+actionId+" -->");
    expect(issue.body).toContain("not an approved code change");
  });
  it("requires admin identity, D1 and configured repository",async()=>{
    expect((await handleAgentHandoff(makeRequest(),base,{sub:"x",email:"reader@example.com"}))?.status).toBe(403);
    expect((await handleAgentHandoff(makeRequest(),base,admin))?.status).toBe(503);
    const {db}=makeDb();
    expect((await handleAgentHandoff(makeRequest(),{...base,META:db,GITHUB_REPOSITORY:""},admin))?.status).toBe(503);
  });
  it("claims an approved action exactly once and creates one scoped issue",async()=>{
    const {db}=makeDb();
    const fetcher=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>{
      expect(String(url)).toBe("https://api.github.com/repos/example/work-items/issues");
      expect(init?.method).toBe("POST");
      const headers=new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer "+"a".repeat(40));
      const body=JSON.parse(String(init?.body));
      expect(body.title).toContain("checkout failures");
      return new Response(JSON.stringify({
        html_url:"https://github.com/example/work-items/issues/42",number:42
      }),{status:201});
    });
    const first=await handleAgentHandoff(makeRequest(),{...base,META:db},admin,fetcher);
    expect(first?.status).toBe(201);
    expect((await first?.json() as {issueNumber:number}).issueNumber).toBe(42);
    const second=await handleAgentHandoff(makeRequest(),{...base,META:db},admin,fetcher);
    expect(second?.status).toBe(409);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("records uncertain status on failed GitHub response and never retries automatically",async()=>{
    const {db,state}=makeDb();
    const fetcher=vi.fn(async()=>new Response("failure",{status:502}));
    const result=await handleAgentHandoff(makeRequest(),{...base,META:db},admin,fetcher);
    expect(result?.status).toBe(502);
    expect(state().handoff_status).toBe("uncertain");
    expect((await handleAgentHandoff(makeRequest(),{...base,META:db},admin,fetcher))?.status).toBe(409);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("rejects unapproved actions and missing confirmation",async()=>{
    const {db}=makeDb({...row(),status:"proposed"});
    const fetcher=vi.fn(async()=>new Response("unexpected"));
    expect((await handleAgentHandoff(makeRequest(),{...base,META:db},admin,fetcher))?.status).toBe(409);
    const {db:approved}=makeDb();
    const request=new Request(makeRequest().url,{method:"POST",
      headers:{"Origin":"https://analytics.example"},
      body:JSON.stringify({confirm:"NO"})});
    expect((await handleAgentHandoff(request,{...base,META:approved},admin,fetcher))?.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

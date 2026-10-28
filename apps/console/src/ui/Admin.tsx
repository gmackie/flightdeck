import {useEffect,useState} from "react";
import "./admin.css";

type Tab="health"|"sources"|"budgets"|"approvals"|"audit"|"mcp";
type Source={id:string;displayName:string;enabled:boolean;version:number;rotationPending:boolean;
  policy:Record<string,unknown>;createdAt:string};
type Setting={query_units_monthly:number;ai_investigations_daily:number;version:number};
type Change={id:string;operation:Record<string,unknown>;rationale:string;proposed_by:string;
  status:string;proposed_at:string};
type Audit={id:string;principal:string;action:string;resource_id:string;created_at:string};
const tabs:Tab[]=["health","sources","budgets","approvals","audit","mcp"];
const policyDefault={
  allowedEvents:["page.viewed","rum.*","feature.exposed"],
  allowedProperties:{"page.viewed":["route"],"rum.*":["value","rating","metricId"],
    "feature.exposed":["flagKey","variant","experimentId"]},
  allowedKinds:["product","rum","exposure"],allowedEnvironments:["production","staging"],
  consentRequired:true,graphEnabled:false,maxBatchSize:100,maxBatchBytes:65536
};
async function api(path:string,method="GET",payload?:unknown):Promise<any>{
  const r=await fetch(path,{method,credentials:"same-origin",cache:"no-store",
    ...(method==="GET"?{}:{headers:{"Content-Type":"application/json"},body:JSON.stringify(payload??{})})});
  let value:any;try{value=await r.json();}catch{throw new Error("Admin API returned an invalid response");}
  if(!r.ok)throw new Error(value?.error??"Administrator API unavailable");
  return value;
}
export function Admin(){
  const [tab,setTab]=useState<Tab>("health");
  const [busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("");
  const [overview,setOverview]=useState<any>(null);
  const [sources,setSources]=useState<Source[]>([]);
  const [selected,setSelected]=useState("");
  const [sourceId,setSourceId]=useState("my-application");
  const [sourceName,setSourceName]=useState("My application");
  const [newPolicy,setNewPolicy]=useState(JSON.stringify(policyDefault,null,2));
  const [editPolicy,setEditPolicy]=useState("");
  const [secret,setSecret]=useState(""),[secretFor,setSecretFor]=useState("");
  const [settings,setSettings]=useState<Setting|null>(null);
  const [queryUnits,setQueryUnits]=useState(50000),[aiLimit,setAiLimit]=useState(3);
  const [queryUsage,setQueryUsage]=useState<any>(null),[aiUsage,setAiUsage]=useState<any>(null);
  const [requests,setRequests]=useState<Change[]>([]);
  const [audit,setAudit]=useState<Audit[]>([]);
  const [proposal,setProposal]=useState(JSON.stringify({kind:"source.disable",sourceId:"my-application"},null,2));
  const [reason,setReason]=useState("Disable this source while we investigate a telemetry issue.");
  async function reload(target:Tab=tab){
    setBusy(true);setError("");
    try{
      switch(target){
        case "health":setOverview(await api("/api/admin/overview"));break;
        case "sources":setSources((await api("/api/admin/sources")).items??[]);break;
        case "budgets":{
          const d=await api("/api/admin/budgets");
          setSettings(d.settings);
          setQueryUnits(d.settings.query_units_monthly);
          setAiLimit(d.settings.ai_investigations_daily);
          setQueryUsage(d.queryUsage);setAiUsage(d.aiUsage);break;
        }
        case "approvals":setRequests((await api("/api/admin/requests")).items??[]);break;
        case "audit":setAudit((await api("/api/admin/audit")).items??[]);break;
        case "mcp":break;
      }
    }catch(e){setError(String((e as Error).message));}
    finally{setBusy(false);}
  }
  useEffect(()=>{void reload(tab);},[tab]);
  async function action(work:()=>Promise<void>,message:string){
    setBusy(true);setError("");setNotice("");
    try{await work();setNotice(message);await reload(tab);}
    catch(e){setError(String((e as Error).message));}
    finally{setBusy(false);}
  }
  async function createSource(){
    await action(async()=>{
      const result=await api("/api/admin/sources","POST",{
        id:sourceId,displayName:sourceName,policy:JSON.parse(newPolicy)
      });
      setSecret(result.token);setSecretFor(result.id);
    },"Created source. Copy the token now; Flightdeck does not store it in plaintext.");
  }
  async function updateSource(row:Source,payload:Record<string,unknown>){
    await action(async()=>{await api("/api/admin/sources/"+encodeURIComponent(row.id),
      "PATCH",{expectedVersion:row.version,...payload});},
      "Source policy/status updated.");
  }
  async function rotate(row:Source){
    if(!window.confirm("Create a replacement credential? Old token remains active until promotion."))return;
    await action(async()=>{
      const r=await api("/api/admin/sources/"+encodeURIComponent(row.id)+"/rotate",
        "POST",{expectedVersion:row.version});
      setSecret(r.token);setSecretFor(row.id);
    },"New token created. Update app Worker secrets before promoting.");
  }
  async function promote(row:Source){
    const provided=secretFor===row.id?secret:window.prompt("Paste the new rotation token")??"";
    if(!provided||!window.confirm("Confirm all app Workers have the replacement token; old token is revoked now."))return;
    await action(async()=>{
      await api("/api/admin/sources/"+encodeURIComponent(row.id)+"/promote","POST",{
        expectedVersion:row.version,token:provided
      });
      setSecret("");setSecretFor("");
    },"Rotation completed. Old source token revoked.");
  }
  async function cancelRotation(row:Source){
    await action(async()=>{await api("/api/admin/sources/"+encodeURIComponent(row.id)+"/cancel-rotation",
      "POST",{expectedVersion:row.version});setSecret("");setSecretFor("");},
      "Pending source rotation cancelled.");
  }
  async function saveBudget(){
    if(!settings)return;
    await action(async()=>{await api("/api/admin/budgets","PUT",{
      queryUnits,aiDailyLimit:aiLimit,expectedVersion:settings.version
    });},"Admission budgets updated.");
  }
  async function propose(){
    await action(async()=>{await api("/api/admin/requests","POST",{
      operation:JSON.parse(proposal),rationale:reason
    });},"Change proposal saved for administrator review.");
  }
  async function decide(row:Change,decision:"approve"|"reject"){
    const why=window.prompt("Administrator review rationale (12 or more characters)")??"";
    if(why.trim().length<12)return;
    if(decision==="approve"&&!window.confirm("Apply this bounded D1 control-plane change?"))return;
    await action(async()=>{
      await api("/api/admin/requests/"+encodeURIComponent(row.id)+"/decision",
        "POST",{decision,rationale:why,confirm:"APPLY_CHANGE"});
    },decision==="approve"?"Approved operation applied.":"Change rejected.");
  }
  function section(title:string,description:string,body:React.ReactNode){
    return <section className="fd-admin-card"><h3>{title}</h3><p>{description}</p>{body}</section>;
  }
  const active=sources.find(s=>s.id===selected);
  return <div className="fd-admin">
    <header className="fd-admin-intro"><div>
      <span className="eyebrow">FLIGHTDECK CONTROL PLANE</span>
      <h2>Administration</h2>
      <p>Account-owned sources, policies, access, budgets, audit and agent approvals.</p>
    </div><button disabled={busy} onClick={()=>void reload()}>Refresh</button></header>
    <nav className="fd-admin-tabs">{tabs.map(t=><button key={t}
      className={tab===t?"active":""} onClick={()=>setTab(t)}>
      {t==="mcp"?"Admin MCP":t[0].toUpperCase()+t.slice(1)}</button>)}</nav>
    {error&&<div className="fd-admin-error">{error}</div>}
    {notice&&<div className="fd-admin-success">{notice}</div>}
    {tab==="health"&&section("Installation health",
      "Private RPC connection and configuration reported by the installed Cloudflare Workers.",
      <div className="fd-admin-metrics">
        {Object.entries({
          "Project":overview?.projectId??"—",
          "Registered sources":overview?.sourceCount??"—",
          "Enabled":overview?.activeSources??"—",
          "Pending requests":overview?.pendingChanges??"—",
          "Core RPC":overview?.core?.ok?"Connected":"Unavailable",
          "Historical sink":overview?.core?.mode??"—",
          "Source registry":overview?.core?.sourceRegistryMode??"—",
          "Access":overview?.accessConfigured?"Configured":"Not configured"
        }).map(([key,value])=><div className="fd-admin-stat" key={key}>
          <span>{key}</span><b>{String(value)}</b></div>)}
      </div>)}
    {tab==="sources"&&<div className="fd-admin-stack">
      {section("Registered application collectors",
        "Each Worker/DO authenticates its own frontend, then uses a Flightdeck service binding.",
        <div><div className="fd-admin-table"><table><thead><tr>
          <th>Source</th><th>Enabled</th><th>Version</th><th>Rotation</th><th>Actions</th>
        </tr></thead><tbody>{sources.map(row=><tr key={row.id}>
          <td><strong>{row.displayName}</strong><small>{row.id}</small></td>
          <td>{row.enabled?"Yes":"No"}</td><td>{row.version}</td>
          <td>{row.rotationPending?"Pending":"Current"}</td>
          <td><button onClick={()=>{
            setSelected(selected===row.id?"":row.id);
            setEditPolicy(JSON.stringify(row.policy,null,2));
          }}>Manage</button></td></tr>)}</tbody></table></div>
          {!sources.length&&<p>No sources registered.</p>}
          {active&&<div className="fd-admin-editor" key={active.id}>
            <h4>Manage {active.id}</h4><div className="fd-admin-buttons">
              <button disabled={busy} onClick={()=>void updateSource(active,{enabled:!active.enabled})}>
                {active.enabled?"Disable source":"Enable source"}</button>
              {!active.rotationPending&&<button disabled={busy} onClick={()=>void rotate(active)}>Rotate token</button>}
              {active.rotationPending&&<>
                <button disabled={busy} onClick={()=>void promote(active)}>Promote new token</button>
                <button disabled={busy} onClick={()=>void cancelRotation(active)}>Cancel rotation</button>
              </>}
            </div><label>Event collection policy
              <textarea rows={10} spellCheck={false} value={editPolicy}
                onChange={e=>setEditPolicy(e.target.value)}/></label>
            <button disabled={busy} onClick={()=>void action(async()=>{
              await api("/api/admin/sources/"+encodeURIComponent(active.id),"PATCH",{
                expectedVersion:active.version,policy:JSON.parse(editPolicy)
              });
            },"Source policy updated.")}>Save policy</button>
          </div>}
        </div>)}
      {section("Register a new Worker/DO",
        "A source token is shown only once. Store it as a Worker secret, never in browser JavaScript.",
        <div><div className="fd-admin-fields">
          <label>Source ID<input value={sourceId} onChange={e=>setSourceId(e.target.value)}/></label>
          <label>Display name<input value={sourceName} onChange={e=>setSourceName(e.target.value)}/></label>
        </div><label>Initial collection policy
          <textarea rows={9} value={newPolicy} onChange={e=>setNewPolicy(e.target.value)}/></label>
          <button className="fd-admin-primary" disabled={busy} onClick={()=>void createSource()}>Create source & token</button>
          {secret&&<div className="fd-admin-secret"><b>One-time source token for {secretFor}</b>
            <input readOnly value={secret} type="text"/>
            <div className="fd-admin-buttons">
              <button onClick={()=>void navigator.clipboard.writeText(secret)}>Copy token</button>
              <button onClick={()=>{setSecret("");setSecretFor("");}}>Hide token</button>
            </div><small>Keep this token server-side. Do not paste it into an MCP client.</small>
          </div>}
        </div>)}
    </div>}
    {tab==="budgets"&&section("Cost admission budgets",
      "Controls relative analytics and AI usage, not Cloudflare billing or spending.",
      <div><div className="fd-admin-metrics">
        <div className="fd-admin-stat"><span>Monthly query units used</span><b>{queryUsage?.units_used??"—"}</b></div>
        <div className="fd-admin-stat"><span>Daily AI investigations used</span><b>{aiUsage?.investigations_used??"—"}</b></div>
      </div><div className="fd-admin-fields">
        <label>Monthly query units<input type="number" value={queryUnits} min={0} max={100000000}
          onChange={e=>setQueryUnits(Number(e.target.value))}/></label>
        <label>Daily AI investigations<input type="number" value={aiLimit} min={0} max={100}
          onChange={e=>setAiLimit(Number(e.target.value))}/></label>
      </div><button disabled={busy||!settings} className="fd-admin-primary"
        onClick={()=>void saveBudget()}>Save admission budgets</button></div>)}
    {tab==="approvals"&&<div className="fd-admin-stack">
      {section("Proposed administrative changes",
        "MCP agents can propose bounded operations. Only an authenticated administrator can review/apply them.",
        <div className="fd-admin-requests">{requests.map(row=><div className="fd-admin-request" key={row.id}>
          <b>{String(row.operation.kind)}</b><small>{row.status} · {row.proposed_by}</small>
          <pre>{JSON.stringify(row.operation,null,2)}</pre><p>{row.rationale}</p>
          {row.status==="pending"&&<div className="fd-admin-buttons">
            <button className="fd-admin-primary" onClick={()=>void decide(row,"approve")}>Review & apply</button>
            <button onClick={()=>void decide(row,"reject")}>Reject</button>
          </div>}
          {row.status==="failed"&&<span>Requires manual reconciliation; no automatic retry.</span>}
        </div>)}{!requests.length&&<p>No pending requests.</p>}</div>)}
      {section("Propose a change",
        "Only source enable/disable/policy updates and analysis budget changes are permitted.",
        <div><label>Operation JSON<textarea rows={5} value={proposal}
          onChange={e=>setProposal(e.target.value)}/></label>
          <label>Rationale<textarea rows={3} value={reason}
            onChange={e=>setReason(e.target.value)}/></label>
          <button className="fd-admin-primary" disabled={busy} onClick={()=>void propose()}>Submit proposal</button>
        </div>)}
    </div>}
    {tab==="audit"&&section("Project audit history","Recent configuration and approval changes.",
      <div className="fd-admin-table"><table><thead><tr>
        <th>When</th><th>Principal</th><th>Action</th><th>Resource</th>
      </tr></thead><tbody>{audit.map(row=><tr key={row.id}>
        <td>{row.created_at}</td><td>{row.principal}</td><td>{row.action}</td>
        <td>{row.resource_id}</td>
      </tr>)}</tbody></table></div>)}
    {tab==="mcp"&&section("Administrator MCP",
      "Access-authenticated tools for observation and proposing restricted changes.",
      <div><p>In your Cloudflare account, the optional Flightdeck MCP Worker serves /mcp. The same Access admin allowlist applies to both the Console and MCP Worker.</p>
        <p>Available admin tools: health, source inventory, budgets, audit log, pending proposals, and proposal creation. MCP never returns source credentials or directly applies changes.</p>
        <pre>{"MCP URL: https://<installed-flightdeck-mcp-workers.dev>/mcp"}</pre>
        <p>Agents must present a valid Cloudflare Access assertion; they cannot authenticate with a public browser token. Confirm proposals under <b>Approvals</b>.</p>
      </div>)}
  </div>;
}

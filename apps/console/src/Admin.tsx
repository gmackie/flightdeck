import {useEffect,useState} from "react";

type Check={id:string;ok:boolean;description:string};
type Status={projectId:string;accountId?:string;checks:Check[];activeSources:number;setupComplete:boolean;note:string};
type SourcePolicy={allowedEvents:string[];allowedProperties:Record<string,string[]>;allowedEnvironments:string[];allowedKinds:string[];consentRequired:boolean;graphEnabled:boolean};
type Source={id:string;enabled:boolean;rotationPending?:boolean;policy:SourcePolicy;createdAt:string;updatedAt:string};
const defaults:SourcePolicy={
  allowedEvents:["page.viewed","rum.*"],
  allowedProperties:{"page.viewed":["route"],"rum.*":["value","rating","metricId"]},
  allowedEnvironments:["production","staging"],allowedKinds:["product","rum"],
  consentRequired:false,graphEnabled:false
};
async function api<T>(path:string,method="GET",payload?:unknown):Promise<T>{
  const res=await fetch(path,{method,credentials:"same-origin",cache:"no-store",
    headers:method==="GET"?undefined:{"Content-Type":"application/json"},
    ...(method==="GET"?{}:{body:JSON.stringify(payload)})});
  const value=await res.json() as T & {error?:string};
  if(!res.ok)throw new Error(value.error??"Admin API unavailable");
  return value;
}
export function AdminWorkspace(){
  const [status,setStatus]=useState<Status|null>(null);
  const [sources,setSources]=useState<Source[]>([]);
  const [error,setError]=useState("");
  const [busy,setBusy]=useState(false);
  const [sourceId,setSourceId]=useState("");
  const [events,setEvents]=useState("page.viewed,rum.*");
  const [requireConsent,setRequireConsent]=useState(false);
  const [oneTimeSecret,setSecret]=useState<{id:string;token:string}|null>(null);
  const [copied,setCopied]=useState(false);
  const [activeStep,setActiveStep]=useState(0);
  async function refresh(){
    setError("");
    try{
      const [stat,list]=await Promise.all([
        api<Status>("/api/admin/status"),
        api<{items:Source[]}>("/api/admin/sources")
      ]);
      setStatus(stat);setSources(list.items);
    }catch(e){setError(String((e as Error).message));}
  }
  useEffect(()=>{void refresh();},[]);
  async function create(){
    if(!sourceId.trim())return;
    setBusy(true);setError("");setSecret(null);
    try{
      const names=events.split(",").map(x=>x.trim()).filter(Boolean);
      const policy={...defaults,allowedEvents:names,consentRequired:requireConsent,
        allowedProperties:Object.fromEntries(names.map(x=>[x,defaults.allowedProperties[x]??[]]))};
      const result=await api<{id:string;token:string}>("/api/admin/sources","POST",{
        id:sourceId.trim(),policy,confirm:"CREATE_SOURCE"
      });
      setSecret(result);setCopied(false);setSourceId("");await refresh();
    }catch(e){setError(String((e as Error).message));}
    finally{setBusy(false);}
  }
  async function action(id:string,act:"rotate"|"retire-old"|"disable"|"enable"){
    if(!window.confirm(`Confirm ${act} for source ${id}?`))return;
    setBusy(true);setError("");setSecret(null);
    try{
      const result=await api<{id:string;token?:string}>(
        "/api/admin/sources/"+encodeURIComponent(id)+"/"+act,
        "POST",{confirm:act==="retire-old"?"APPLY_RETIRE_OLD":"APPLY_"+act.toUpperCase()}
      );
      if(result.token){setSecret({id,token:result.token});setCopied(false);}
      await refresh();
    }catch(e){setError(String((e as Error).message));}
    finally{setBusy(false);}
  }
  const steps=[
    {title:"Cloudflare account",info:"Run the local wizard with your own Wrangler session. Select the account, Worker names and deployment host."},
    {title:"Basin and D1",info:"Create an R2 Catalog, Basin stream and D1 database. The wizard stores only account-specific IDs and secret hashes."},
    {title:"Cloudflare Access",info:"Protect the console with a self-hosted Access application. Every request must verify a signed Access JWT."},
    {title:"Deploy and verify",info:"Apply versioned migrations, deploy Core and Console, then validate anonymous denial and one authenticated end-to-end event."},
    {title:"Connect applications",info:"Add a service binding and server-side source token to each Worker/DO. Browser events go through your own authenticated app route."}
  ];
  return <div className="stack">
    <section className="panel">
      <div className="panel-head"><div><h2>Deployment health</h2>
        <p>Account-owned configuration checks (not a live Cloudflare resource audit)</p></div>
        <button className="tiny-button" onClick={()=>void refresh()}>Refresh</button></div>
      {error&&<p className="error-state">{error}</p>}
      {status?<div className="admin-health-grid">
        {status.checks.map(item=><div key={item.id} className="admin-health-item">
          <span aria-label={item.ok?"configured":"needs attention"} className={item.ok?"admin-check-ok":"admin-check-failed"}>
            {item.ok?"✓":"!"}</span>
          <div><b>{item.id}</b><small>{item.description}</small></div>
        </div>)}
      </div>:<div className="empty">Loading installation state…</div>}
      <p className="note">{status?.note??"The admin API requires the D1 source-credentials migration."}</p>
    </section>
    <section className="panel">
      <div className="panel-head"><div><h2>Self-hosted installation wizard</h2>
        <p>Configuration and guided setup; account-wide provisioning is performed by the local CLI, not by a browser session.</p>
      </div></div>
      <div className="admin-wizard">
        <div className="admin-wizard-steps">
          {steps.map((step,i)=><button key={step.title}
            className={"admin-wizard-step "+(activeStep===i?"active":"")}
            onClick={()=>setActiveStep(i)}>
            <span>{i+1}</span>{step.title}</button>)}
        </div>
        <div className="admin-wizard-detail">
          <span className="eyebrow">STEP {activeStep+1} OF {steps.length}</span>
          <h3>{steps[activeStep]!.title}</h3><p>{steps[activeStep]!.info}</p>
          <pre>{activeStep===0?"pnpm wizard":activeStep===4?
            `"services": [{ "binding": "FLIGHTDECK", "service": "flightdeck-core" }]`:
            activeStep===3?"pnpm workspace:doctor":"pnpm wizard --resume"}</pre>
          <div className="inline-actions">
            <button disabled={activeStep===0} className="tiny-button" onClick={()=>setActiveStep(v=>v-1)}>Previous</button>
            <button disabled={activeStep===steps.length-1} className="primary" onClick={()=>setActiveStep(v=>v+1)}>Next step</button>
          </div>
        </div>
      </div>
      <p className="note">Never enter Cloudflare API secrets into this console. Run <code>pnpm wizard</code> locally to authenticate and provision resources.</p>
    </section>
    <section className="panel">
      <div className="panel-head"><div><h2>Application sources</h2>
        <p>Each Worker/DO owns its frontend authentication. Flightdeck authorizes the private service-binding source separately.</p></div>
        <span className="ok-label">{sources.filter(s=>s.enabled).length} enabled</span></div>
      {sources.length?<div className="table-scroll"><table><thead><tr>
        <th>Source</th><th>Status</th><th>Events</th><th>Actions</th>
      </tr></thead><tbody>{sources.map(source=><tr key={source.id}>
        <td>{source.id}</td><td>{source.enabled?"Enabled":"Disabled"}</td>
        <td>{source.policy.allowedEvents.join(", ")}</td><td className="admin-actions">
          <button disabled={busy} className="tiny-button" onClick={()=>void action(source.id,"rotate")}>Rotate key</button>{" "}
          {source.rotationPending&&<button disabled={busy} className="tiny-button" onClick={()=>void action(source.id,"retire-old")}>Retire old key</button>}{" "}
          <button disabled={busy} className="tiny-button" onClick={()=>void action(source.id,source.enabled?"disable":"enable")}>
            {source.enabled?"Disable":"Enable"}</button>
        </td></tr>)}</tbody></table></div>:<div className="empty">No dynamic sources created yet.</div>}
      <div className="admin-create">
        <h3>Register a new application</h3>
        <div className="insight-form">
          <label>Source ID<input value={sourceId} onChange={e=>setSourceId(e.target.value)} placeholder="checkout-worker"/></label>
          <label>Allowed events<input value={events} onChange={e=>setEvents(e.target.value)}/></label>
        </div>
        <label className="admin-checkbox"><input type="checkbox" checked={requireConsent}
          onChange={e=>setRequireConsent(e.target.checked)}/> Require an authenticated application consent assertion</label>
        <button className="primary" disabled={busy||!sourceId.trim()} onClick={()=>void create()}>Create source and credential</button>
      </div>
      {oneTimeSecret&&<div className="admin-secret">
        <h3>One-time credential for {oneTimeSecret.id}</h3>
        <p>Store this as a server-side Worker secret. It will not be available from the admin API again.</p>
        <code>{oneTimeSecret.token}</code>
        <div className="inline-actions">
          <button className="tiny-button" onClick={()=>{void navigator.clipboard.writeText(oneTimeSecret.token).then(()=>setCopied(true));}}>
            {copied?"Copied":"Copy credential"}</button>
          <button className="tiny-button" onClick={()=>setSecret(null)}>Dismiss permanently</button>
        </div>
      </div>}
    </section>
    <section className="panel"><h2>Administration by MCP</h2>
      <p>Authorized agents can read health/source inventory and propose work. Mutating operations require a separate administrator permission gate and explicit confirmation; no arbitrary Wrangler, shell or Cloudflare account API execution is exposed.</p>
      <div className="link-row"><a href="https://github.com/gmackie/flightdeck/blob/feat/11-admin-console-mcp-wizard/docs/admin-operations.md"
        rel="noopener noreferrer" target="_blank">Admin API and MCP guide ↗</a></div>
    </section>
  </div>;
}

import {useEffect,useMemo,useState,type ReactNode} from "react";

type Row = Record<string,unknown>;
type Section = "overview"|"events"|"funnels"|"retention"|"journeys"|"experience"|"experiments"|"sources";
const sections:{id:Section;title:string;icon:string;group:string}[]=[
 {id:"overview",title:"Overview",icon:"▤",group:"Explore"},
 {id:"events",title:"Event Explorer",icon:"≡",group:"Explore"},
 {id:"funnels",title:"Funnels",icon:"⋈",group:"Analyze"},
 {id:"retention",title:"Retention",icon:"▦",group:"Analyze"},
 {id:"journeys",title:"Journeys",icon:"↬",group:"Analyze"},
 {id:"experience",title:"Experience / RUM",icon:"⌁",group:"Observe"},
 {id:"experiments",title:"Experiments",icon:"◈",group:"Observe"},
 {id:"sources",title:"Integrations",icon:"⚙",group:"Configure"},
];
function rows(response:unknown):Row[]{
  const v=response as any;
  const candidates=[v?.data?.result?.rows,v?.data?.result?.data,v?.data?.rows,v?.data?.data,
    v?.data?.result,v?.result?.rows,v?.rows,v?.data];
  for(const c of candidates){
    if(Array.isArray(c))return c.filter(x=>x&&typeof x==="object") as Row[];
  }
  return [];
}
function text(x:unknown):string{return x===null||x===undefined?"—":String(x);}
function count(x:unknown):string{
 const n=Number(x);
 return Number.isFinite(n)?new Intl.NumberFormat().format(n):"—";
}
function fmtDate(x:unknown):string{
 const d=new Date(String(x));
 return Number.isFinite(d.getTime())?d.toLocaleString():text(x);
}
function useData(endpoint:string,days:number,refresh:number){
 const [data,setData]=useState<Row[]>([]);
 const [loading,setLoading]=useState(true);
 const [error,setError]=useState("");
 useEffect(()=>{
  const ctrl=new AbortController();
  const now=new Date(),before=new Date(now.getTime()-days*86_400_000);
  const u=endpoint+"?from="+encodeURIComponent(before.toISOString())+"&to="+encodeURIComponent(now.toISOString());
  setLoading(true);setError("");
  fetch(u,{signal:ctrl.signal,credentials:"same-origin",cache:"no-store"})
    .then(async res=>{const json=await res.json() as {error?:string;data?:unknown};if(!res.ok)throw new Error(json.error??"Query failed");return json;})
    .then(json=>{setData(rows(json));setLoading(false);})
    .catch(err=>{if(!ctrl.signal.aborted){setError(String(err.message??err));setLoading(false);}});
  return ()=>ctrl.abort();
 },[endpoint,days,refresh]);
 return {data,loading,error};
}
function Panel({children,title,sub,action}:{children:ReactNode,title:string;sub?:string;action?:ReactNode}){
 return <section className="panel"><header className="panel-head"><div><h2>{title}</h2>{sub&&<p>{sub}</p>}</div>{action}</header>{children}</section>;
}
function Message({loading,error,empty=false}:{loading:boolean;error:string;empty?:boolean}){
 if(loading)return <div className="empty"><span className="spinner"/>Loading from your Basin catalog…</div>;
 if(error)return <div className="empty error-state">Unable to query: {error}<p>Check the Access policy, Basin SQL credentials, warehouse and pipeline.</p></div>;
 if(empty)return <div className="empty">No matching events in this time range.<p>Send an event through your application's Worker service binding to populate this view.</p></div>;
 return null;
}
function Metric({label,value,desc}:{label:string,value:string,desc?:string}){
 return <div className="metric"><div className="eyebrow">{label}</div><strong>{value}</strong>{desc&&<small>{desc}</small>}</div>;
}
function Bars({data,labelKey,valueKey}:{data:Row[],labelKey:string,valueKey:string}){
 const max=Math.max(1,...data.map(r=>Number(r[valueKey])||0));
 return <div className="bars">{data.map((r,i)=><div className="bar-row" key={i}>
  <span title={text(r[labelKey])}>{text(r[labelKey])}</span>
  <div className="track"><div className="fill" style={{width:(Math.max(0,Number(r[valueKey])||0)/max*100)+"%"}}/></div>
  <b>{count(r[valueKey])}</b></div>)}</div>;
}
function LineChart({data}:{data:Row[]}){
 const values=data.map(d=>Number(d.events)||0),max=Math.max(1,...values);
 const points=values.map((v,i)=>`${25+(i/Math.max(1,values.length-1))*750},${180-v/max*140}`).join(" ");
 return <div className="chart"><svg viewBox="0 0 800 210" role="img" aria-label="Daily event counts">
  {[0,1,2,3].map(i=><line key={i} x1="25" x2="775" y1={40+i*47} y2={40+i*47} stroke="currentColor" opacity=".12"/>)}
  <polyline points={points} fill="none" stroke="#49dac3" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round"/>
  {values.map((v,i)=><circle key={i} cx={25+(i/Math.max(1,values.length-1))*750} cy={180-v/max*140} r="3" fill="#49dac3"/>)}
 </svg><div className="axis"><span>{text(data[0]?.day)}</span><span>{text(data[data.length-1]?.day)}</span></div></div>;
}
function Overview({days,refresh}:{days:number;refresh:number}){
 const summary=useData("/api/overview",days,refresh);
 const trends=useData("/api/trends",days,refresh);
 const top=useData("/api/top-events",days,refresh);
 const s=summary.data[0]??{};
 return <div className="stack">
  <div className="metric-grid">
   <Metric label="Events observed" value={count(s.events)} desc="Accepted historical events"/>
   <Metric label="Active actors (approx)" value={count(s.actors)} desc="Distinct known actor IDs"/>
   <Metric label="Sessions (approx)" value={count(s.sessions)} desc="Distinct session IDs"/>
   <Metric label="Active sources" value="—" desc="Source diagnostics planned"/>
  </div>
  <div className="two-col">
   <Panel title="Event volume" sub="Daily recorded events, based on occurrence time">
    <Message loading={trends.loading} error={trends.error} empty={!trends.data.length}/>
    {trends.data.length>0&&<LineChart data={trends.data}/>}
   </Panel>
   <Panel title="Top events" sub="Most frequent event names">
    <Message loading={top.loading} error={top.error} empty={!top.data.length}/>
    {top.data.length>0&&<Bars data={top.data} labelKey="event_name" valueKey="events"/>}
   </Panel>
  </div>
  <Panel title="What Flightdeck understands" sub="Only measured signals—not AI-generated claims">
   <div className="feature-strip"><div><b>Behavior</b><p>Explore conversion, cohorts and paths derived from real event sequences.</p></div>
   <div><b>Experience</b><p>Compare browser Web Vitals and backend business milestones.</p></div>
   <div><b>Experiments</b><p>Review exposure counts. Flagship stays in the Cloudflare dashboard.</p></div></div>
  </Panel>
  <Message loading={summary.loading} error={summary.error}/>
 </div>;
}
function Events({days,refresh}:{days:number;refresh:number}){
 const result=useData("/api/events",days,refresh);
 const [filter,setFilter]=useState("");
 const [expanded,setExpanded]=useState<string|null>(null);
 const filtered=result.data.filter(r=>text(r.event_name).toLowerCase().includes(filter.toLowerCase()));
 return <Panel title="Event Explorer" sub="Canonical events accepted into your historical Basin pipeline"
 action={<input className="search" value={filter} onChange={e=>setFilter(e.target.value)} placeholder="Filter event names"/>}>
  <Message loading={result.loading} error={result.error} empty={!result.data.length}/>
  {result.data.length>0&&<div className="table-scroll"><table>
   <thead><tr><th>Event</th><th>Actor</th><th>Source</th><th>Occurred</th><th>Details</th></tr></thead>
   <tbody>{filtered.map((r,i)=><tr key={i}>
    <td><span className="event-name">{text(r.event_name)}</span></td>
    <td className="mono">{text(r.actor_id)}</td><td>{text(r.source_id)}</td>
    <td>{fmtDate(r.occurred_at)}</td>
    <td><button className="tiny-button" onClick={()=>setExpanded(expanded===String(i)?null:String(i))}>{expanded===String(i)?"Hide":"Inspect"}</button>
    {expanded===String(i)&&<pre>{JSON.stringify({properties:parseJSON(r.properties_json),objects:parseJSON(r.objects_json),eventId:r.event_id},null,2)}</pre>}</td>
   </tr>)}</tbody>
  </table></div>}
 </Panel>;
}
function parseJSON(s:unknown){try{return JSON.parse(String(s));}catch{return s;}}
function Funnels({days}:{days:number}){
 const [steps,setSteps]=useState("signup.completed, project.created, project.activated");
 const [result,setResult]=useState<Row[]>([]);
 const [running,setRunning]=useState(false);
 const [error,setError]=useState("");
 async function run(){
  setRunning(true);setError("");
  try{
   const to=new Date(),from=new Date(to.getTime()-days*86_400_000);
   const res=await fetch("/api/funnel",{method:"POST",credentials:"same-origin",
    headers:{"Content-Type":"application/json"},body:JSON.stringify({from:from.toISOString(),to:to.toISOString(),steps:steps.split(",").map(x=>x.trim()).filter(Boolean)})});
   const data=await res.json() as {error?:string;data?:unknown};if(!res.ok)throw new Error(data.error??"Query failed");
   setResult(rows(data));
  }catch(e){setError(String((e as Error).message));}finally{setRunning(false);}
 }
 return <div className="stack">
  <Panel title="Funnel builder" sub="Ordered conversions by actor identity. First matching occurrence per stage.">
   <label className="field-label">Event sequence (2–5 event names, comma separated)</label>
   <div className="inline-form"><input value={steps} onChange={e=>setSteps(e.target.value)}/><button className="primary" onClick={()=>void run()} disabled={running}>{running?"Running…":"Analyze funnel"}</button></div>
   {error&&<div className="error-state">{error}</div>}
  </Panel>
  <Panel title="Conversion breakdown" sub="Historical occurrence order; not a causal experiment">
   {!result.length?<div className="empty">Run a funnel query to see measured conversion stages.</div>:<Bars data={result} labelKey="event_name" valueKey="actors"/>}
  </Panel>
 </div>;
}
function Retention({days,refresh}:{days:number;refresh:number}){
 const q=useData("/api/retention",Math.min(days,30),refresh);
 const cohorts=useMemo(()=>{
  const map=new Map<string,Map<number,number>>();
  for(const r of q.data){
   const d=String(r.cohort_day),a=String(r.active_day);
   const age=Math.round((Date.parse(a+"T00:00:00Z")-Date.parse(d+"T00:00:00Z"))/86_400_000);
   if(age<0||age>7)continue;
   if(!map.has(d))map.set(d,new Map());
   map.get(d)!.set(age,Number(r.retained)||0);
  }
  return [...map.entries()].slice(-14).reverse();
 },[q.data]);
 return <Panel title="Retention cohorts" sub="Calendar-day returning actors, relative to their first observed event in the selected range">
  <Message loading={q.loading} error={q.error} empty={!q.data.length}/>
  {!!cohorts.length&&<div className="table-scroll"><table className="cohort-table"><thead>
   <tr><th>First seen</th>{Array.from({length:8},(_,i)=><th key={i}>D{i}</th>)}</tr></thead><tbody>
   {cohorts.map(([day,vals])=>{const base=vals.get(0)??0;return <tr key={day}><td>{day}</td>{Array.from({length:8},(_,i)=>{
    const n=vals.get(i),pct=base&&n!==undefined?n/base*100:0;
    return <td key={i} style={{background:n===undefined?"transparent":`rgba(53,211,177,${.08+pct/100*.55})`}}>{n===undefined?"—":pct.toFixed(0)+"%"}</td>;
   })}</tr>;})}
   </tbody></table></div>}
  <p className="note">The query limits displayed cohort cells for cost. It is not yet a complete retention materialization.</p>
 </Panel>;
}
function Journeys({days,refresh}:{days:number;refresh:number}){
 const q=useData("/api/journeys",days,refresh);
 return <Panel title="Observed journey transitions" sub="A directly-follows graph discovered from ordered, actor-scoped events">
  <Message loading={q.loading} error={q.error} empty={!q.data.length}/>
  {!!q.data.length&&<div className="transition-list">{q.data.map((r,i)=><div className="transition" key={i}>
   <span className="pill">{text(r.from_event)}</span><span className="arrow">→</span>
   <span className="pill">{text(r.to_event)}</span><strong>{count(r.transitions)} transitions</strong>
  </div>)}</div>}
  <p className="note">This is deterministic process discovery; AI naming, cross-session object journeys, and DO compilation remain planned.</p>
 </Panel>;
}
function Experience({days,refresh}:{days:number;refresh:number}){
 const q=useData("/api/experience",days,refresh);
 const limits:Record<string,number>={"rum.lcp":2500,"rum.inp":200,"rum.cls":.1,"rum.ttfb":800};
 const units:Record<string,string>={"rum.lcp":"ms","rum.inp":"ms","rum.cls":"","rum.ttfb":"ms"};
 return <div className="stack">
  <div className="metric-grid">{["rum.lcp","rum.inp","rum.cls","rum.ttfb"].map(name=>{
   const r=q.data.find(x=>x.event_name===name);
   const value=Number(r?.p75);
   return <Metric key={name} label={name.toUpperCase().slice(4)+" p75"}
     value={r&&Number.isFinite(value)?(name==="rum.cls"?value.toFixed(3):Math.round(value).toLocaleString())+(units[name]??""):"—"}
     desc={r?(value<=(limits[name]??Infinity)?"Within reference threshold":"Investigate experience regression"):"No measurements"}/>;
  })}</div>
  <Panel title="Core Web Vitals" sub="Distribution summaries from your own browser SDK">
   <Message loading={q.loading} error={q.error} empty={!q.data.length}/>
   {!!q.data.length&&<div className="table-scroll"><table><thead><tr><th>Metric</th><th>p75</th><th>Samples</th></tr></thead>
   <tbody>{q.data.map((r,i)=><tr key={i}><td>{text(r.event_name)}</td><td>{text(r.p75)}</td><td>{count(r.samples)}</td></tr>)}</tbody></table></div>}
  </Panel>
 </div>;
}
function Experiments({days,refresh}:{days:number;refresh:number}){
 const q=useData("/api/experiments",days,refresh);
 return <div className="stack"><Panel title="Flag exposures" sub="Observed exposures only; rollout management remains in Cloudflare Flagship">
  <Message loading={q.loading} error={q.error} empty={!q.data.length}/>
  {!!q.data.length&&<div className="table-scroll"><table><thead><tr><th>Flag</th><th>Variant</th><th>Exposure events</th></tr></thead>
   <tbody>{q.data.map((r,i)=><tr key={i}><td>{text(r.flag_key)}</td><td><span className="pill">{text(r.variant)}</span></td><td>{count(r.exposures)}</td></tr>)}</tbody></table></div>}
  <div className="link-row"><a href="https://dash.cloudflare.com/" target="_blank" rel="noopener noreferrer">Open Cloudflare dashboard ↗</a></div>
  </Panel><Panel title="Experiment interpretation" sub="Avoid conflating rollout cohorts and randomized assignments">
   <p className="muted">Exposure counts alone do not measure experimental lift. Randomized assignment provenance, goal attribution and statistical guardrails are required before presenting causal conclusions.</p>
  </Panel></div>;
}
function Sources(){
 return <div className="stack"><Panel title="Self-hosted deployment" sub="Application-owned collection—no Flightdeck public collector required">
  <div className="integration"><div><span className="integration-icon">CF</span><div><h3>Workers service binding</h3><p>Calls from your Worker and Durable Objects to the private Analytics Core.</p></div></div><span className="ok-label">Recommended</span></div>
  <pre className="code-sample">{`// wrangler.jsonc
"services": [{ "binding":"FLIGHTDECK", "service":"flightdeck-core" }]

// inside an authenticated Worker or Durable Object
await analytics.track("project.created", { template: "blank" });`}</pre>
  <div className="integration"><div><span className="integration-icon">SDK</span><div><h3>First-party frontend SDK</h3><p>Browser events post to your own origin. Your Worker authenticates and forwards allowlisted data.</p></div></div></div>
  <div className="integration"><div><span className="integration-icon">B</span><div><h3>Basin Catalog</h3><p>Canonical analytical events are stored in your Cloudflare R2/Iceberg table.</p></div></div></div>
  <div className="link-row"><a href="https://github.com/gmackie/flightdeck/blob/feat/bootstrap-architecture/docs/service-bindings.md" target="_blank" rel="noopener noreferrer">Integration documentation ↗</a></div>
 </Panel></div>;
}
function getSection():Section {
 const id=location.hash.slice(1) as Section;return sections.some(s=>s.id===id)?id:"overview";
}
export function App(){
 const [selected,setSelected]=useState<Section>(getSection);
 const [days,setDays]=useState(30);
 const [refresh,setRefresh]=useState(0);
 const [project,setProject]=useState("Flightdeck");
 const [menuOpen,setMenuOpen]=useState(false);
 useEffect(()=>{
  const listener=()=>{setSelected(getSection());setMenuOpen(false);};
  window.addEventListener("hashchange",listener);
  fetch("/api/config",{credentials:"same-origin"}).then(r=>r.ok?r.json():null).then(v=>{const config=v as {projectId?:string}|null;if(config?.projectId)setProject(config.projectId);}).catch(()=>{});
  return()=>window.removeEventListener("hashchange",listener);
 },[]);
 let content:ReactNode;
 switch(selected){
 case "overview":content=<Overview days={days} refresh={refresh}/>;break;
 case "events":content=<Events days={days} refresh={refresh}/>;break;
 case "funnels":content=<Funnels days={days}/>;break;
 case "retention":content=<Retention days={days} refresh={refresh}/>;break;
 case "journeys":content=<Journeys days={days} refresh={refresh}/>;break;
 case "experience":content=<Experience days={days} refresh={refresh}/>;break;
 case "experiments":content=<Experiments days={days} refresh={refresh}/>;break;
 case "sources":content=<Sources/>;break;
 }
 const navTitle=sections.find(s=>s.id===selected)?.title;
 return <div className="shell">
  <aside className={"sidebar "+(menuOpen?"open":"")}>
   <a className="brand" href="#overview"><span className="brand-mark">F</span><span><b>flightdeck</b><small>PRODUCT INTELLIGENCE</small></span></a>
   <div className="workspace"><span className="workspace-avatar">{project.slice(0,1).toUpperCase()}</span><div><b>{project}</b><small>Self-hosted · Cloudflare</small></div></div>
   <nav>{sections.map((item,i)=><div key={item.id}>
    {(i===0||sections[i-1]?.group!==item.group)&&<span className="nav-group">{item.group}</span>}
    <a href={"#"+item.id} aria-current={selected===item.id?"page":undefined} className={"nav-link "+(selected===item.id?"active":"")}>
      <span className="nav-icon">{item.icon}</span>{item.title}
    </a></div>)}</nav>
   <div className="sidebar-footer"><span className="live-dot"/> Connected to your Cloudflare account <small>Flightdeck v0.1 · Early access</small></div>
  </aside>
  <main className="main">
   <header className="topbar"><div className="topbar-left">
    <button className="mobile-menu" aria-label="Toggle menu" onClick={()=>setMenuOpen(!menuOpen)}>☰</button>
    <span className="breadcrumb">Flightdeck</span><span className="slash">/</span><span>{navTitle}</span>
   </div><div className="topbar-right"><span className="status-chip"><span className="live-dot"/> Basin Analytics</span>
    <select value={days} aria-label="Time range" onChange={e=>setDays(Number(e.target.value))}>
     <option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option>
    </select><button aria-label="Refresh analytics" className="icon-button" onClick={()=>setRefresh(r=>r+1)}>↻</button>
   </div></header>
   <div className="content"><div className="page-heading"><div><p className="eyebrow">ANALYTICS WORKSPACE</p><h1>{navTitle}</h1>
     <p>Understand how people, services and agents experience your product.</p></div>
     <span className="beta-tag">SELF-HOSTED BETA</span></div>{content}
    <footer className="footer">Your account · Your data · Evidence before inference</footer>
   </div>
  </main>
 </div>;
}

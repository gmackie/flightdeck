import {useEffect,useMemo,useState,type ReactNode} from "react";

type Row = Record<string,unknown>;
type Section = "overview"|"events"|"insights"|"dashboards"|"funnels"|"retention"|"journeys"|"experience"|"experiments"|"sources";
const sections:{id:Section;title:string;icon:string;group:string}[]=[
 {id:"overview",title:"Overview",icon:"▤",group:"Explore"},
 {id:"events",title:"Event Explorer",icon:"≡",group:"Explore"},
 {id:"insights",title:"Saved Insights",icon:"▣",group:"Explore"},
 {id:"dashboards",title:"Dashboards",icon:"⊞",group:"Explore"},
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
type DefinitionItem={
 id:string;objectType:string;initialState:string;version:number;enabled:boolean;
 transitions:Array<{from:string;event:string;to:string}>;
 terminalStates?:string[];maxDurationDays?:number;
};
function JourneyDefinitions(){
 const [items,setItems]=useState<DefinitionItem[]>([]);
 const [id,setId]=useState("first-project");
 const [objectType,setObjectType]=useState("project");
 const [initial,setInitial]=useState("created");
 const [terminal,setTerminal]=useState("activated");
 const [transitions,setTransitions]=useState('[{"from":"created","event":"project.opened","to":"configuring"},{"from":"configuring","event":"project.created","to":"activated"}]');
 const [error,setError]=useState("");
 const [message,setMessage]=useState("");
 const [busy,setBusy]=useState(false);
 const [inspectType,setInspectType]=useState("project");
 const [inspectId,setInspectId]=useState("");
 const [snapshot,setSnapshot]=useState<unknown>(null);
 async function load(){
  try{
   const res=await fetch("/api/journey-definitions",{credentials:"same-origin"});
   const body=await res.json() as {items?:DefinitionItem[];error?:string};
   if(!res.ok)throw new Error(body.error??"Unable to load definitions");
   setItems(body.items??[]);
  }catch(err){setError(String((err as Error).message));}
 }
 useEffect(()=>{void load();},[]);
 async function create(){
  setBusy(true);setError("");setMessage("");
  try{
   const body={
    id,objectType,initialState:initial,
    terminalStates:terminal.split(",").map(x=>x.trim()).filter(Boolean),
    maxDurationDays:30,
    transitions:JSON.parse(transitions),
   };
   const res=await fetch("/api/journey-definitions",{
    method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},
    body:JSON.stringify(body)
   });
   const payload=await res.json() as {error?:string};
   if(!res.ok)throw new Error(payload.error??"Creation failed");
   setMessage("Draft created. It is disabled until reviewed and explicitly approved.");
   await load();
  }catch(err){setError(String((err as Error).message));}
  finally{setBusy(false);}
 }
 async function toggle(item:DefinitionItem){
  const approval=item.enabled?"":window.prompt("Approval rationale (min. 12 characters)")??"";
  if(!item.enabled&&!approval)return;
  setBusy(true);setError("");setMessage("");
  try{
   const res=await fetch("/api/journey-definitions/"+encodeURIComponent(item.id),{
    method:"PATCH",credentials:"same-origin",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({expectedVersion:item.version,enabled:!item.enabled,approval})
   });
   const payload=await res.json() as {error?:string};
   if(!res.ok)throw new Error(payload.error??"Update failed");
   setMessage("Definition status updated. New events will use approved version "+item.version+".");
   await load();
  }catch(err){setError(String((err as Error).message));}
  finally{setBusy(false);}
 }
 async function inspect(){
  setError("");setSnapshot(null);
  try{
   const params=new URLSearchParams({type:inspectType,objectId:inspectId});
   const res=await fetch("/api/journey-state?"+params,{credentials:"same-origin"});
   const payload=await res.json() as {error?:string};
   if(!res.ok)throw new Error(payload.error??"State unavailable");
   setSnapshot(payload);
  }catch(err){setError(String((err as Error).message));}
 }
 return <div className="stack">
  <Panel title="Executable journey definitions" sub="Compiled, versioned state machines; disabled until explicitly approved">
   {error&&<div className="error-state">{error}</div>}
   {message&&<p className="ok-label">{message}</p>}
   {!items.length?<div className="empty">No journey definitions configured.</div>:
    <div className="table-scroll"><table><thead><tr>
     <th>Journey</th><th>Object</th><th>Version</th><th>Status</th><th>Action</th>
    </tr></thead><tbody>{items.map(item=><tr key={item.id}>
     <td>{item.id}</td><td>{item.objectType}</td><td>v{item.version}</td>
     <td>{item.enabled?<span className="ok-label">Active</span>:"Draft"}</td>
     <td><button className="tiny-button" disabled={busy} onClick={()=>void toggle(item)}>
      {item.enabled?"Disable":"Review & enable"}</button></td>
    </tr>)}</tbody></table></div>}
   <details className="journey-creator"><summary>Author a deterministic definition</summary>
    <div className="insight-form">
     <label>Definition ID<input value={id} onChange={e=>setId(e.target.value)}/></label>
     <label>Object type<input value={objectType} onChange={e=>setObjectType(e.target.value)}/></label>
     <label>Initial state<input value={initial} onChange={e=>setInitial(e.target.value)}/></label>
     <label>Terminal states<input value={terminal} onChange={e=>setTerminal(e.target.value)}/></label>
    </div>
    <label className="field-label">Transitions (JSON array)</label>
    <textarea value={transitions} onChange={e=>setTransitions(e.target.value)} rows={5}/>
    <p className="note">The server validates state reachability and deterministic transitions. Creation never enables execution.</p>
    <button className="primary" disabled={busy} onClick={()=>void create()}>Create disabled definition</button>
   </details>
  </Panel>
  <Panel title="Inspect a live object" sub="Administrator-only inspection through the private Journey Worker service binding">
   <div className="insight-form">
    <label>Object type<input value={inspectType} onChange={e=>setInspectType(e.target.value)}/></label>
    <label>Object ID<input value={inspectId} onChange={e=>setInspectId(e.target.value)}/></label>
   </div>
   <button className="primary" disabled={!inspectId} onClick={()=>void inspect()}>Inspect state</button>
   {snapshot!==null?<pre>{JSON.stringify(snapshot,null,2)}</pre>:null}
  </Panel>
 </div>;
}
function Journeys({days,refresh}:{days:number;refresh:number}){
 const q=useData("/api/journeys",days,refresh);
 const [proposals,setProposals]=useState<Array<{
  candidate:{id:string;events:string[];minEdgeObservations:number};
  interpretation?:{title:string;summary:string;hypothesis:string;confidence:string};
  error?:string;
 }>>([]);
 const [aiLoading,setAiLoading]=useState(false);
 const [aiError,setAiError]=useState("");
 async function discover(){
  setAiLoading(true);setAiError("");
  try{
   const response=await fetch("/api/discover",{
    method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},
    body:"{}"
   });
   const payload=await response.json() as {suggestions?:typeof proposals;error?:string};
   if(!response.ok)throw new Error(payload.error??"Discovery unavailable");
   setProposals(payload.suggestions??[]);
  }catch(e){setAiError(String((e as Error).message));}finally{setAiLoading(false);}
 }
 return <div className="stack">
  <JourneyDefinitions/>
  <Panel title="Observed journey transitions" sub="A directly-follows graph discovered from ordered, actor-scoped events">
   <Message loading={q.loading} error={q.error} empty={!q.data.length}/>
   {!!q.data.length&&<div className="transition-list">{q.data.map((r,i)=><div className="transition" key={i}>
    <span className="pill">{text(r.from_event)}</span><span className="arrow">→</span>
    <span className="pill">{text(r.to_event)}</span><strong>{count(r.transitions)} transitions</strong>
   </div>)}</div>}
   <p className="note">Edge frequencies are not user-completion rates. Object-scoped journey machines use a separate optional DO runtime.</p>
  </Panel>
  <Panel title="AI Journey Discovery" sub="Semantic interpretation of measured aggregate paths; opt-in Workers AI">
   <div className="inline-form">
    <button className="primary" disabled={aiLoading} onClick={()=>void discover()}>{aiLoading?"Analyzing…":"Discover candidate journeys"}</button>
    <span className="note">No raw user events are sent to the model.</span>
   </div>
   {aiError&&<div className="error-state">{aiError} — see the AI discovery configuration docs.</div>}
   <div className="transition-list">
    {proposals.map(item=><div className="discovery-card" key={item.candidate.id}>
     <div><span className="eyebrow">PROPOSED PATH · NOT APPROVED</span>
      <h3>{item.interpretation?.title??"Unnamed behavioral path"}</h3>
      <p>{item.interpretation?.summary??"Deterministic path only. AI interpretation is unavailable."}</p>
     </div>
     <div className="transition">
      {item.candidate.events.map((event,i)=><span key={i} className="pill">{event}{i<item.candidate.events.length-1?" → ":""}</span>)}
     </div>
     <p className="note">Minimum edge frequency: {item.candidate.minEdgeObservations} · Not a path completion count.</p>
     {item.interpretation&&<p className="note">Hypothesis ({item.interpretation.confidence} confidence): {item.interpretation.hypothesis}</p>}
    </div>)}
   </div>
  </Panel>
 </div>;
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
type InsightItem = {
 id:string;name:string;query:{kind:string;days:number;steps?:string[];eventName?:string};updated_at:string;
};
type DashboardItem = {
 id:string;title:string;layout:Array<{insightId:string;x:number;y:number;w:number;h:number}>;updatedAt:string;
};
function DataTable({data}:{data:Row[]}){
 if(!data.length)return <div className="empty">No rows returned.</div>;
 const keys=Object.keys(data[0]??{}).slice(0,9);
 return <div className="table-scroll"><table><thead><tr>{keys.map(k=><th key={k}>{k}</th>)}</tr></thead>
  <tbody>{data.slice(0,50).map((item,i)=><tr key={i}>{keys.map(k=><td key={k}>{text(item[k])}</td>)}</tr>)}</tbody></table></div>;
}
function SavedInsights(){
 const [items,setItems]=useState<InsightItem[]>([]);
 const [name,setName]=useState("Activation funnel");
 const [kind,setKind]=useState("funnel");
 const [days,setDays]=useState(7);
 const [steps,setSteps]=useState("signup.completed,project.created");
 const [error,setError]=useState("");
 const [busy,setBusy]=useState(false);
 const [results,setResults]=useState<Row[]|null>(null);
 const [active,setActive]=useState("");
 async function load(){
  try {
   const response=await fetch("/api/insights",{credentials:"same-origin"});
   const body=await response.json() as {items?:InsightItem[];error?:string};
   if(!response.ok)throw new Error(body.error??"Unable to list insights");
   setItems(body.items??[]);
  }catch(e){setError(String((e as Error).message));}
 }
 useEffect(()=>{void load();},[]);
 async function save(){
  setBusy(true);setError("");
  try{
   const response=await fetch("/api/insights",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({name,query:{kind,days,...(kind==="funnel"?{steps:steps.split(",").map(x=>x.trim())}:{})}})});
   const body=await response.json() as {error?:string};
   if(!response.ok)throw new Error(body.error??"Save failed");
   await load();
  }catch(e){setError(String((e as Error).message));}finally{setBusy(false);}
 }
 async function run(id:string){
  setBusy(true);setActive(id);setError("");
  try{
   const response=await fetch("/api/insights/"+encodeURIComponent(id)+"/run",{
    method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:"{}"
   });
   const body=await response.json() as {error?:string};
   if(!response.ok)throw new Error(body.error??"Query failed");
   setResults(rows(body));
  }catch(e){setError(String((e as Error).message));setResults(null);}finally{setBusy(false);}
 }
 async function remove(id:string){
  if(!window.confirm("Delete this saved insight?"))return;
  setBusy(true);setError("");
  try{
   const response=await fetch("/api/insights/"+encodeURIComponent(id),{
    method:"DELETE",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:"{}"
   });
   const body=await response.json() as {error?:string};
   if(!response.ok)throw new Error(body.error??"Delete failed");
   await load();
  }catch(e){setError(String((e as Error).message));}finally{setBusy(false);}
 }
 return <div className="stack">
  <Panel title="Create a saved insight" sub="Reusable, project-scoped queries with rolling time windows">
   <div className="insight-form">
    <label>Title<input value={name} onChange={e=>setName(e.target.value)} maxLength={120}/></label>
    <label>Analysis<select value={kind} onChange={e=>setKind(e.target.value)}>
     {["overview","top-events","trends","recent-events","funnel","retention","rum","experiments","transitions"].map(x=><option key={x} value={x}>{x}</option>)}
    </select></label>
    <label>Window<select value={days} onChange={e=>setDays(Number(e.target.value))}>
     {[1,7,14,30].map(x=><option key={x} value={x}>Last {x} days</option>)}
    </select></label>
   </div>
   {kind==="funnel"&&<label className="insight-steps">Ordered event steps<input value={steps} onChange={e=>setSteps(e.target.value)}/></label>}
   <button disabled={busy} onClick={()=>void save()} className="primary">Save insight</button>
  </Panel>
  <Panel title="Saved insights" sub="Available to authenticated Flightdeck users; editing requires admin permission">
   {error&&<p className="error-state">{error}</p>}
   {items.length===0?<div className="empty">No saved insights yet, or metadata database not configured.</div>:
   <div className="table-scroll"><table><thead><tr><th>Title</th><th>Type</th><th>Window</th><th>Actions</th></tr></thead>
   <tbody>{items.map(item=><tr key={item.id}><td>{item.name}</td><td>{item.query.kind}</td>
    <td>{item.query.days} days</td>
    <td><button className="tiny-button" disabled={busy} onClick={()=>void run(item.id)}>Run</button>{" "}
      <button className="tiny-button" disabled={busy} onClick={()=>void remove(item.id)}>Delete</button></td></tr>)}
   </tbody></table></div>}
  </Panel>
  {results&&<Panel title={"Query results · "+(items.find(x=>x.id===active)?.name??"Insight")}>
   <DataTable data={results}/>
  </Panel>}
 </div>;
}
function DashboardWidget({insight}:{insight:InsightItem|undefined}){
 const [data,setData]=useState<Row[]|null>(null),[error,setError]=useState("");
 useEffect(()=>{
  if(!insight)return;
  const c=new AbortController();
  fetch("/api/insights/"+encodeURIComponent(insight.id)+"/run",{
   method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:"{}",signal:c.signal
  }).then(async r=>{const p=await r.json() as {error?:string};if(!r.ok)throw new Error(p.error??"Query failed");return rows(p);})
   .then(setData).catch(e=>{if(!c.signal.aborted)setError(String(e.message));});
  return ()=>c.abort();
 },[insight?.id]);
 return <div className="dashboard-widget"><h3>{insight?.name??"Missing insight"}</h3>
  {error?<div className="error-state">{error}</div>:data?<DataTable data={data}/>:<div className="empty">Loading…</div>}</div>;
}
function Dashboards(){
 const [items,setItems]=useState<DashboardItem[]>([]);
 const [insights,setInsights]=useState<InsightItem[]>([]);
 const [name,setName]=useState("Product health");
 const [selected,setSelected]=useState<string[]>([]);
 const [active,setActive]=useState<string|null>(null);
 const [error,setError]=useState("");
 async function load(){
  try{
   const responses=await Promise.all(["/api/dashboards","/api/insights"].map(url=>fetch(url,{credentials:"same-origin"})));
   const [d,i]=await Promise.all(responses.map(r=>r.json() as Promise<{items?:any[];error?:string}>));
   if(!responses[0]?.ok||!responses[1]?.ok)throw new Error(d.error??i.error??"Metadata unavailable");
   setItems(d.items??[]);setInsights(i.items??[]);
  }catch(e){setError(String((e as Error).message));}
 }
 useEffect(()=>{void load();},[]);
 async function save(){
  setError("");
  const layout=selected.map((insightId,i)=>({insightId,x:(i%2)*6,y:Math.floor(i/2)*4,w:6,h:4}));
  try{
   const response=await fetch("/api/dashboards",{method:"POST",headers:{"Content-Type":"application/json"},
    credentials:"same-origin",body:JSON.stringify({title:name,layout})});
   const payload=await response.json() as {error?:string};
   if(!response.ok)throw new Error(payload.error??"Create failed");
   await load();
  }catch(e){setError(String((e as Error).message));}
 }
 const dashboard=items.find(x=>x.id===active);
 return <div className="stack">
  <Panel title="Dashboard composer" sub="Combine saved, bounded analytics queries into a reusable workspace">
   <label className="field-label">Dashboard name</label>
   <input className="search" value={name} onChange={e=>setName(e.target.value)}/>
   <p>Choose up to 12 saved insights to display.</p>
   <div className="checkbox-grid">{insights.map(i=><label key={i.id}>
    <input type="checkbox" checked={selected.includes(i.id)} onChange={e=>setSelected(prev=>e.target.checked?
      [...prev,i.id].slice(0,12):prev.filter(id=>id!==i.id))}/> {i.name}</label>)}</div>
   <button className="primary" onClick={()=>void save()} disabled={!selected.length}>Create dashboard</button>
  </Panel>
  <Panel title="Available dashboards">
   {error&&<div className="error-state">{error}</div>}
   {items.length===0?<div className="empty">No dashboards yet.</div>:
   <div className="transition-list">{items.map(d=><div className="integration" key={d.id}>
    <div><b>{d.title}</b><span className="note">{d.layout.length} widgets</span></div>
    <button className="tiny-button" onClick={()=>setActive(d.id)}>Open</button>
   </div>)}</div>}
  </Panel>
  {dashboard&&<Panel title={dashboard.title} sub="Queries run with server-side project isolation and budget checks">
   <div className="dashboard-grid">{dashboard.layout.map((w,i)=>
    <DashboardWidget key={i} insight={insights.find(x=>x.id===w.insightId)}/>)}</div>
  </Panel>}
 </div>;
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
 case "insights":content=<SavedInsights/>;break;
 case "dashboards":content=<Dashboards/>;break;
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

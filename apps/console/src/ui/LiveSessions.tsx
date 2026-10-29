import {useEffect,useState} from "react";
import {startLivePolling} from "./live-poll";

type Session={sourceId:string;sessionId:string;actorId:string;environment:string;
 firstSeen:string;lastSeen:string;lastEvent:string;events:number};
type Snapshot={sessions:Session[];updatedAt:string;windowSeconds:number;maxEvents:number;retainedEvents:number};
export function LiveSessions({refresh}:{refresh:number}){
 const [snapshot,setSnapshot]=useState<Snapshot|null>(null);
 const [error,setError]=useState("");
 const [paused,setPaused]=useState(false);
 const [visible,setVisible]=useState(!document.hidden);
 useEffect(()=>{
  if(paused)return;
  return startLivePolling({visibility:document,onVisibility:setVisible,
   load:async signal=>{
    const response=await fetch("/api/live-sessions",{signal,credentials:"same-origin",cache:"no-store",redirect:"error"});
    if(!response.ok)throw new Error(response.status===401||response.status===403?
     "Your session expired. Sign in again to resume live updates.":"Live sessions are unavailable. Retrying automatically.");
    const value=await response.json() as Snapshot;
    if(!Array.isArray(value.sessions)||!value.updatedAt)throw new Error("Invalid session response. Retrying automatically.");
    return value;
   },
   onValue:value=>{setSnapshot(value as Snapshot);setError("");},
   onError:reason=>setError(reason instanceof Error?reason.message:"Live session update failed. Retrying automatically.")
  });
 },[paused,refresh]);
 const status=paused||!visible?"Paused":error?"Reconnecting":snapshot?"Updating every 2 seconds":"Connecting";
 return <section className="panel">
  <header className="panel-head"><div><h2>Live sessions</h2><p>Recent session activity from accepted events · last 30 minutes</p></div>
   <button className="tiny-button" onClick={()=>setPaused(p=>!p)}>{paused?"Resume updates":"Pause updates"}</button></header>
  <p role="status">{status}{snapshot?" · Last updated "+new Date(snapshot.updatedAt).toLocaleTimeString():""}</p>
  {error&&<p role="alert" className="error-state">{error}</p>}
  {!snapshot&&!error&&<div className="empty"><span className="spinner"/>Connecting to live sessions…</div>}
  {snapshot&&snapshot.sessions.length===0&&<div className="empty">No recent sessions.<p>New events with a session ID appear here as they arrive.</p></div>}
  {snapshot&&snapshot.sessions.length>0&&<div className="table-scroll"><table>
   <thead><tr><th>Session</th><th>Actor</th><th>Source</th><th>Environment</th><th>Last event</th><th>Events</th><th>Last activity</th></tr></thead>
   <tbody>{snapshot.sessions.map(s=><tr key={JSON.stringify([s.sourceId,s.environment,s.sessionId])}>
    <td className="mono">{s.sessionId}</td><td className="mono">{s.actorId||"Anonymous"}</td><td>{s.sourceId}</td>
    <td>{s.environment}</td><td className="event-name">{s.lastEvent}</td><td>{s.events}</td><td>{new Date(s.lastSeen).toLocaleTimeString()}</td>
   </tr>)}</tbody></table></div>}
  <p className="note">Shows up to 100 sessions from a bounded sample of the latest {snapshot?.maxEvents??256} events.
   Counts cover retained events. Sessions expire after 30 minutes without new activity.
   Historical analytics remain available in Event Explorer.</p>
 </section>;
}

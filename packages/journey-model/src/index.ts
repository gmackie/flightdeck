/**
 * Versioned, deterministic journey definition validator and replay engine.
 * Never executes arbitrary AI-produced scripts.
 */
export type JourneyTransition={from:string;event:string;to:string};
export type JourneyDefinition={
  id:string;projectId:string;objectType:string;version:number;
  initialState:string;transitions:JourneyTransition[];
  terminalStates?:string[];
  maxDurationDays?:number;
};
export type JourneyObservation={
  eventId:string;sourceId:string;eventName:string;occurredAt:string;
};
export type AppliedTransition={
  eventId:string;sourceId:string;eventName:string;at:string;
  from:string;to:string;
};
export type JourneySnapshot={
  journeyId:string;version:number;state:string;lastOccurrence:string|null;
  appliedTransitions:AppliedTransition[];observedEvents:number;
};
const identifier=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const label=/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const event=/^[a-z][a-z0-9_.-]{0,127}$/;
const maxHistory=4096;
export class JourneyError extends Error{
  constructor(readonly code:string){super(code);this.name="JourneyError";}
}
export function validateJourney(input:unknown):JourneyDefinition {
  if(!input||typeof input!=="object"||Array.isArray(input))throw new JourneyError("invalid_definition");
  const d=input as JourneyDefinition;
  if(!identifier.test(d.id)||!identifier.test(d.projectId)||!identifier.test(d.objectType)||
     !label.test(d.initialState)||!Number.isInteger(d.version)||d.version<1||
     !Array.isArray(d.transitions)||d.transitions.length<1||d.transitions.length>50)
    throw new JourneyError("invalid_definition");
  if(d.maxDurationDays!==undefined && (!Number.isInteger(d.maxDurationDays)||d.maxDurationDays<1||d.maxDurationDays>30))
    throw new JourneyError("invalid_duration");
  const terminal=d.terminalStates??[];
  if(!Array.isArray(terminal)||terminal.length>12||!terminal.every(x=>label.test(x)))
    throw new JourneyError("invalid_terminal_states");
  const keys=new Set<string>();
  const states=new Set<string>([d.initialState]);
  for(const t of d.transitions){
    if(!t||!label.test(t.from)||!label.test(t.to)||!event.test(t.event))
      throw new JourneyError("invalid_transition");
    const key=t.from+":"+t.event;
    if(keys.has(key))throw new JourneyError("ambiguous_transition");
    if(terminal.includes(t.from))throw new JourneyError("terminal_state_has_outgoing_transition");
    keys.add(key);states.add(t.from);states.add(t.to);
  }
  for(const state of terminal)if(!states.has(state))throw new JourneyError("unknown_terminal_state");
  // A broken unreachable model would silently miscount paths. Prohibit it.
  const reachable=new Set([d.initialState]);
  for(let i=0;i<d.transitions.length;i++){
    let changed=false;
    for(const t of d.transitions)if(reachable.has(t.from)&&!reachable.has(t.to)){
      reachable.add(t.to);changed=true;
    }
    if(!changed)break;
  }
  for(const state of states)if(!reachable.has(state))throw new JourneyError("unreachable_state");
  return {
    id:d.id,projectId:d.projectId,objectType:d.objectType,version:d.version,
    initialState:d.initialState,transitions:d.transitions.map(t=>({...t})),
    ...(terminal.length?{terminalStates:[...terminal]}:{}),
    ...(d.maxDurationDays?{maxDurationDays:d.maxDurationDays}:{}),
  };
}
export function transition(d:JourneyDefinition,state:string,eventName:string):string {
  if(d.terminalStates?.includes(state))return state;
  return d.transitions.find(t=>t.from===state&&t.event===eventName)?.to??state;
}
function validObservation(o:JourneyObservation):boolean {
  return !!o && identifier.test(o.eventId)&&identifier.test(o.sourceId)&&event.test(o.eventName) &&
    Number.isFinite(Date.parse(o.occurredAt));
}
/**
 * Deterministic replay of canonical observations for one business object.
 * Calling code must ensure records belong to the same project/object.
 * The returned appliedTransitions are evidence, not inferred intent.
 */
export function replayJourney(
  definition:JourneyDefinition, observations:readonly JourneyObservation[],
  now=Date.now()
):JourneySnapshot{
  const d=validateJourney(definition);
  if(observations.length>maxHistory)throw new JourneyError("history_limit_exceeded");
  const seen=new Set<string>();
  const accepted:JourneyObservation[]=[];
  const oldest=now-(d.maxDurationDays??30)*86_400_000;
  for(const o of observations){
    if(!validObservation(o))throw new JourneyError("invalid_observation");
    const when=Date.parse(o.occurredAt);
    if(when<oldest || when>now+300_000)continue;
    const id=o.sourceId+":"+o.eventId;
    if(seen.has(id))continue;
    seen.add(id);accepted.push(o);
  }
  accepted.sort((a,b)=>a.occurredAt.localeCompare(b.occurredAt)||
    a.sourceId.localeCompare(b.sourceId)||a.eventId.localeCompare(b.eventId));
  let state=d.initialState,lastOccurrence:string|null=null;
  const appliedTransitions:AppliedTransition[]=[];
  for(const o of accepted){
    const next=transition(d,state,o.eventName);
    if(next!==state){
      appliedTransitions.push({
        eventId:o.eventId,sourceId:o.sourceId,eventName:o.eventName,
        at:o.occurredAt,from:state,to:next,
      });
      state=next;lastOccurrence=o.occurredAt;
    }
  }
  return {journeyId:d.id,version:d.version,state,lastOccurrence,
    appliedTransitions,observedEvents:accepted.length};
}

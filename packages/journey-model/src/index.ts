/** Deterministic, versioned journey definition validation and state transition engine. */
export type JourneyTransition={from:string;event:string;to:string};
export interface JourneyDefinition{
  id:string;projectId:string;objectType:string;version:number;
  initialState:string;transitions:JourneyTransition[];
}
const identifier=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const label=/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const event=/^[a-z][a-z0-9_.-]{0,127}$/;
export class JourneyError extends Error{constructor(readonly code:string){super(code);}}
export function validateJourney(input:unknown):JourneyDefinition {
 if(!input||typeof input!=="object"||Array.isArray(input))throw new JourneyError("invalid_definition");
 const d=input as JourneyDefinition;
 if(!identifier.test(d.id)||!identifier.test(d.projectId)||!identifier.test(d.objectType)||!label.test(d.initialState)||
  !Number.isInteger(d.version)||d.version<1||!Array.isArray(d.transitions)||
  d.transitions.length<1||d.transitions.length>50)throw new JourneyError("invalid_definition");
 const keys=new Set<string>();
 for(const t of d.transitions){
  if(!t||!label.test(t.from)||!label.test(t.to)||!event.test(t.event))throw new JourneyError("invalid_transition");
  const key=t.from+":"+t.event;
  if(keys.has(key))throw new JourneyError("ambiguous_transition");
  keys.add(key);
 }
 return d;
}
export function transition(d:JourneyDefinition,state:string,eventName:string):string {
 return d.transitions.find(t=>t.from===state&&t.event===eventName)?.to??state;
}

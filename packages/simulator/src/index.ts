/**
 * Bounded observational journey transition simulator. Transition frequencies
 * are interpreted as a finite-horizon Markov model. NOT a causal counterfactual.
 */
export interface ObservedTransition{
  from_event:string;to_event:string;transitions:number;
}
export interface Scenario{
  from:string;to:string;multiplier:number;
}
export interface SimulationInput{
  start:string;goal:string;
  maxSteps?:number;
  transitions:readonly ObservedTransition[];
  scenario?:Scenario;
}
export interface SimulationResult{
  start:string;goal:string;maxSteps:number;
  successProbability:number;deadEndProbability:number;
  unresolvedProbability:number;expectedStepsToSuccess:number|null;
  observedEdges:number;
  assumptions:string[];
  causalClaim:false;
}
export class SimulationError extends Error{
  constructor(readonly code:string){super(code);this.name="SimulationError";}
}
const event=/^[a-z][a-z0-9_.-]{0,127}$/;
export function simulateJourney(input:SimulationInput):SimulationResult{
  if(!input||!event.test(input.start)||!event.test(input.goal)||
    !Array.isArray(input.transitions)||input.transitions.length<1||input.transitions.length>200)
    throw new SimulationError("invalid_simulation");
  const maxSteps=input.maxSteps??15;
  if(!Number.isInteger(maxSteps)||maxSteps<1||maxSteps>40)
    throw new SimulationError("invalid_simulation_horizon");
  if(input.scenario&&(!event.test(input.scenario.from)||!event.test(input.scenario.to)||
    !Number.isFinite(input.scenario.multiplier)||input.scenario.multiplier<0||
    input.scenario.multiplier>10))
    throw new SimulationError("invalid_scenario");
  const byStart=new Map<string,Map<string,number>>();
  for(const edge of input.transitions){
    if(!edge||!event.test(edge.from_event)||!event.test(edge.to_event)||
      !Number.isSafeInteger(edge.transitions)||edge.transitions<1)
      throw new SimulationError("invalid_transition_data");
    const targets=byStart.get(edge.from_event)??new Map<string,number>();
    targets.set(edge.to_event,(targets.get(edge.to_event)??0)+edge.transitions);
    byStart.set(edge.from_event,targets);
  }
  let success=input.start===input.goal?1:0,deadEnds=0,weightedSteps=0;
  let active=new Map<string,number>(input.start===input.goal?[]:[[input.start,1]]);
  for(let step=1;step<=maxSteps;step++){
    const next=new Map<string,number>();
    for(const [node,probability] of active){
      const edges=byStart.get(node);
      if(!edges||edges.size===0){deadEnds+=probability;continue;}
      const weighted=[...edges].map(([to,observations])=>{
        const factor=input.scenario?.from===node&&input.scenario.to===to?
          input.scenario.multiplier:1;
        return {to,weight:observations*factor};
      });
      const total=weighted.reduce((sum,x)=>sum+x.weight,0);
      if(total<=0){deadEnds+=probability;continue;}
      for(const edge of weighted){
        if(edge.weight<=0)continue;
        const mass=probability*edge.weight/total;
        if(edge.to===input.goal){
          success+=mass;weightedSteps+=mass*step;
        }else next.set(edge.to,(next.get(edge.to)??0)+mass);
      }
    }
    active=next;
    if(active.size===0)break;
  }
  const unresolved=[...active.values()].reduce((sum,x)=>sum+x,0);
  const bounded=(x:number)=>Math.max(0,Math.min(1,x));
  return {
    start:input.start,goal:input.goal,maxSteps,
    successProbability:bounded(success),deadEndProbability:bounded(deadEnds),
    unresolvedProbability:bounded(unresolved),
    expectedStepsToSuccess:success>0?weightedSteps/success:null,
    observedEdges:input.transitions.length,
    causalClaim:false,
    assumptions:[
      "Transition counts are treated as time-invariant transition weights; this may not hold for real user cohorts.",
      "Finite-horizon probabilities are model estimates, not observed conversion rates.",
      "Changing a transition multiplier is an explicit assumption, not a prediction of a product intervention.",
      "Identity changes, unobserved events, terminal business outcomes and selection bias are not modeled.",
    ],
  };
}

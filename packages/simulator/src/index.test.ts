import {describe,expect,it} from "vitest";
import {simulateJourney} from "./index";
const transitions=[
  {from_event:"signup.completed",to_event:"project.opened",transitions:80},
  {from_event:"signup.completed",to_event:"session.exited",transitions:20},
  {from_event:"project.opened",to_event:"project.created",transitions:60},
];
describe("bounded process transition simulator",()=>{
 it("calculates finite-horizon goal reachability without causal claims",()=>{
  const result=simulateJourney({start:"signup.completed",goal:"project.created",transitions});
  expect(result.successProbability).toBeCloseTo(.8);
  expect(result.deadEndProbability).toBeCloseTo(.2);
  expect(result.expectedStepsToSuccess).toBeCloseTo(2);
  expect(result.causalClaim).toBe(false);
 });
 it("applies hypothetical transition multipliers as explicit assumptions",()=>{
  const result=simulateJourney({start:"signup.completed",goal:"project.created",transitions,
    scenario:{from:"signup.completed",to:"project.opened",multiplier:0}});
  expect(result.successProbability).toBe(0);
  expect(result.deadEndProbability).toBe(1);
 });
 it("bounds simulation depth and invalid transition input",()=>{
  expect(()=>simulateJourney({start:"signup.completed",goal:"project.created",maxSteps:100,transitions}))
    .toThrow("invalid_simulation_horizon");
  expect(()=>simulateJourney({start:"signup.completed",goal:"project.created",transitions:[
    {from_event:"drop sql",to_event:"project.created",transitions:2}
  ]})).toThrow("invalid_transition_data");
 });
});

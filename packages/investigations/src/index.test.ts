import {describe,expect,it} from "vitest";
import {summarizeChanges,validateProposal,deterministicProposal} from "./index";
const window={from:"2026-10-20",to:"2026-10-27",baselineFrom:"2026-10-13",baselineTo:"2026-10-20"};
const evidence=summarizeChanges({"purchase.completed":60},{"purchase.completed":100},window);
describe("evidence-grounded investigations",()=>{
  it("calculates changes with explicit provenance and no causal claim",()=>{
    expect(evidence[0]?.changePercent).toBe(-40);
    expect(deterministicProposal(evidence,"Why is purchase conversion down?").causalInference).toBe(false);
  });
  it("rejects model conclusions lacking measured evidence",()=>{
    expect(()=>validateProposal({title:"Checkout",summary:"Drop",hypotheses:[
      {description:"Broken checkout",confidence:"high",evidenceKeys:["nonexistent"]}
    ],proposedActions:[]},evidence)).toThrow("ungrounded_hypothesis");
  });
  it("does not accept arbitrary executable action kinds",()=>{
    expect(()=>validateProposal({title:"Checkout",summary:"Drop",hypotheses:[],proposedActions:[
      {kind:"run_shell",summary:"Delete database",acceptanceCriteria:[]}
    ]},evidence)).toThrow("invalid_action");
  });
});

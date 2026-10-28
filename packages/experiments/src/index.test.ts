import {describe,expect,it} from "vitest";
import {analyzeExperiment} from "./index";
describe("two-arm exposure conversion analysis",()=>{
  it("reports positive lift without calling it causal",()=>{
    const r=analyzeExperiment(
      {variant:"control",exposed:1000,converted:100},
      {variant:"treatment",exposed:1000,converted:150}
    );
    expect(r.absoluteDifference).toBeCloseTo(.05);
    expect(r.relativeLift).toBeCloseTo(.5);
    expect(r.confidenceInterval95[0]).toBeGreaterThan(0);
    expect(r.causalClaim).toBe(false);
    expect(r.randomizedAssignmentProven).toBe(false);
    expect(r.sampleRatioPValue).toBeCloseTo(1,3);
  });
  it("flags sample ratio mismatch instead of greenlighting a rollout",()=>{
    const r=analyzeExperiment(
      {variant:"control",exposed:1500,converted:300},
      {variant:"treatment",exposed:500,converted:100}
    );
    expect(r.status).toBe("sample_ratio_mismatch");
    expect(r.sampleRatioPValue).toBeLessThan(.01);
  });
  it("does not present underpowered comparisons as successes",()=>{
    expect(analyzeExperiment(
      {variant:"control",exposed:15,converted:1},
      {variant:"treatment",exposed:15,converted:3}
    ).status).toBe("insufficient_data");
  });
  it("rejects invalid conversion counts",()=>{
    expect(()=>analyzeExperiment(
      {variant:"control",exposed:10,converted:11},
      {variant:"treatment",exposed:10,converted:2}
    )).toThrow("invalid_arm_counts");
  });
});
